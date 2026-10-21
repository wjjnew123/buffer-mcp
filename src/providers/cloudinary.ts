import { createHash, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import type { CloudinaryConfig } from "../config/schema.js";
import { getCredentials, type CloudinaryCredentials } from "../config/load.js";
import type { ResolvedConfig } from "../config/schema.js";
import { AppError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type {
  LinkOptions,
  ListAssetsOptions,
  ListAssetsResult,
  MediaProvider,
  ProviderCredentials,
  ResourceType,
  UploadOptions,
  UploadResult,
  UploadSource,
} from "./types.js";

const API_ROOT = "https://api.cloudinary.com/v1_1";

interface CloudinaryResponse {
  public_id?: string;
  secure_url?: string;
  url?: string;
  resource_type?: ResourceType;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  created_at?: string;
  error?: { message?: string };
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function sign(params: Record<string, string | undefined>, secret: string): string {
  const parts = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`);
  return sha1(`${parts.join("&")}${secret}`);
}

function timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

const VARIANT_TRANSFORMS: Record<string, string> = {
  landscape_16_9: "c_pad,w_1920,h_1080,b_black",
  square_1_1: "c_pad,w_1080,h_1080,b_black",
  portrait_4_5: "c_pad,w_1080,h_1350,b_black",
  vertical_9_16: "c_pad,w_1080,h_1920,b_black",
  vertical_9_16_fill: "c_fill,w_1080,h_1920",
};

export class CloudinaryProvider implements MediaProvider {
  readonly name = "cloudinary";

  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private get cfg(): CloudinaryConfig {
    return this.config.cloudinary;
  }

  credentials(): CloudinaryCredentials {
    return getCredentials(this.config, this.env);
  }

  isConfigured(): boolean {
    const creds = this.credentials();
    return Boolean(creds.cloudName && creds.apiKey && creds.apiSecret);
  }

  private requireCredentials(): CloudinaryCredentials {
    const creds = this.credentials();
    if (!creds.cloudName || !creds.apiKey || !creds.apiSecret) {
      throw new AppError(
        "Cloudinary is not configured.",
        "CLOUDINARY_NOT_CONFIGURED",
        "Set cloudinary.cloudName/apiKey/apiSecret in the config file, or the CLOUDINARY_URL / CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET environment variables.",
      );
    }
    return creds;
  }

  private endpoint(resourceType: string, action: string, creds: CloudinaryCredentials): string {
    return `${API_ROOT}/${creds.cloudName}/${resourceType}/${action}`;
  }

  async upload(source: UploadSource, options: UploadOptions = {}): Promise<UploadResult> {
    const creds = this.requireCredentials();
    if (!source.path && !source.url) {
      throw new AppError("upload requires either a local path or a remote url.", "INVALID_UPLOAD_SOURCE");
    }

    const resourceType = options.resourceType ?? this.cfg.resourceType;
    const folder = options.folder ?? this.cfg.folder;
    const overwrite = options.overwrite ?? this.cfg.overwrite;

    const params: Record<string, string | undefined> = {
      timestamp: timestamp(),
      folder: folder || undefined,
      public_id: options.publicId,
      overwrite: overwrite ? "true" : undefined,
      tags: options.tags?.join(","),
    };
    const signature = sign(params, creds.apiSecret);

    if (source.url) {
      return this.uploadFromUrl(creds, resourceType, source.url, params, signature);
    }

    const filePath = path.resolve(source.path as string);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      throw new AppError(`File not found: ${filePath}`, "FILE_NOT_FOUND");
    }

    const chunkThreshold = this.cfg.chunkThresholdMb * 1024 * 1024;
    if (info.size > chunkThreshold) {
      this.logger.info("Using chunked Cloudinary upload", {
        file: path.basename(filePath),
        bytes: info.size,
      });
      return this.uploadChunked(creds, resourceType, filePath, info.size, params, signature);
    }

    const form = new FormData();
    const blob = await openAsBlob(filePath);
    form.append("file", blob, path.basename(filePath));
    this.appendParams(form, creds.apiKey, params, signature);
    return this.post(creds, resourceType, form);
  }

  private appendParams(
    form: FormData,
    apiKey: string,
    params: Record<string, string | undefined>,
    signature: string,
  ): void {
    form.append("api_key", apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") form.append(key, value);
    }
    form.append("signature", signature);
  }

  private async uploadFromUrl(
    creds: CloudinaryCredentials,
    resourceType: string,
    url: string,
    params: Record<string, string | undefined>,
    signature: string,
  ): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", url);
    this.appendParams(form, creds.apiKey, params, signature);
    return this.post(creds, resourceType, form);
  }

  private async uploadChunked(
    creds: CloudinaryCredentials,
    resourceType: string,
    filePath: string,
    total: number,
    params: Record<string, string | undefined>,
    signature: string,
  ): Promise<UploadResult> {
    const chunkSize = Math.max(5 * 1024 * 1024, Math.ceil(total / 8));
    const uploadId = randomUUID();
    const fh = await open(filePath, "r");
    let last: CloudinaryResponse | null = null;

    try {
      for (let start = 0; start < total; start += chunkSize) {
        const end = Math.min(start + chunkSize, total);
        const buffer = Buffer.alloc(end - start);
        await fh.read(buffer, 0, buffer.length, start);

        const form = new FormData();
        form.append("file", new Blob([buffer]), path.basename(filePath));
        this.appendParams(form, creds.apiKey, params, signature);

        const isLast = end >= total;
        const response = await fetch(this.endpoint(resourceType, "upload", creds), {
          method: "POST",
          headers: {
            "X-Unique-Upload-Id": uploadId,
            "Content-Range": `bytes ${start}-${end - 1}/${total}`,
          },
          body: form,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new AppError(
            `Cloudinary chunk upload failed (HTTP ${response.status}): ${text.slice(0, 500)}`,
            "CLOUDINARY_UPLOAD_FAILED",
          );
        }
        if (isLast || text.trim().startsWith("{")) {
          try {
            last = JSON.parse(text) as CloudinaryResponse;
          } catch {
            /* intermediate chunk without JSON body */
          }
          break;
        }
      }
    } finally {
      await fh.close().catch(() => undefined);
    }

    if (!last?.secure_url) {
      throw new AppError("Cloudinary chunked upload returned no result.", "CLOUDINARY_UPLOAD_FAILED");
    }
    return this.toResult(last);
  }

  private async post(
    creds: CloudinaryCredentials,
    resourceType: string,
    form: FormData,
  ): Promise<UploadResult> {
    const response = await fetch(this.endpoint(resourceType, "upload", creds), {
      method: "POST",
      body: form,
    });
    const text = await response.text();
    let body: CloudinaryResponse;
    try {
      body = JSON.parse(text) as CloudinaryResponse;
    } catch {
      throw new AppError(
        `Cloudinary returned a non-JSON response (HTTP ${response.status}).`,
        "CLOUDINARY_UPLOAD_FAILED",
      );
    }
    if (!response.ok || body.error) {
      throw new AppError(
        `Cloudinary upload failed: ${body.error?.message ?? `HTTP ${response.status}`}`,
        "CLOUDINARY_UPLOAD_FAILED",
      );
    }
    return this.toResult(body);
  }

  private toResult(body: CloudinaryResponse): UploadResult {
    if (!body.public_id || !body.secure_url) {
      throw new AppError("Cloudinary response is missing public_id or secure_url.", "CLOUDINARY_UPLOAD_FAILED");
    }
    return {
      provider: this.name,
      publicId: body.public_id,
      secureUrl: body.secure_url,
      resourceType: body.resource_type ?? "image",
      format: body.format,
      bytes: body.bytes,
      width: body.width,
      height: body.height,
      durationMs: body.duration ? Math.round(body.duration * 1000) : undefined,
      createdAt: body.created_at,
    };
  }

  link(publicId: string, options: LinkOptions = {}): string {
    const creds = this.credentials();
    if (!creds.cloudName) {
      throw new AppError("Cloudinary cloud name is not configured.", "CLOUDINARY_NOT_CONFIGURED");
    }
    const resourceType = options.resourceType ?? "image";
    const version = options.version ? `v${String(options.version).replace(/^v/, "")}/` : "";
    const transformation = options.transformation ? `${options.transformation}/` : "";
    return `https://res.cloudinary.com/${creds.cloudName}/${resourceType}/upload/${transformation}${version}${publicId}`;
  }

  variants(publicId: string, resourceType: ResourceType = "video"): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, transformation] of Object.entries(VARIANT_TRANSFORMS)) {
      out[name] = this.link(publicId, { resourceType, transformation });
    }
    return out;
  }

  async listAssets(options: ListAssetsOptions = {}): Promise<ListAssetsResult> {
    const creds = this.requireCredentials();
    const resourceType: ResourceType = options.resourceType ?? "image";
    const maxResults = Math.min(500, Math.max(1, Math.trunc(options.maxResults ?? 20)));
    const params = new URLSearchParams();
    params.set("type", options.type ?? "upload");
    params.set("max_results", String(maxResults));
    if (options.nextCursor) params.set("next_cursor", options.nextCursor);
    if (options.prefix) params.set("prefix", options.prefix);
    if (options.tags?.length) params.set("tags", options.tags.join(","));
    if (options.direction) params.set("direction", options.direction);

    const url = `${API_ROOT}/${encodeURIComponent(creds.cloudName)}/resources/${resourceType}?${params.toString()}`;
    const basic = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString("base64");
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${basic}` },
    });
    const text = await response.text();
    let body: {
      resources?: Array<Record<string, unknown>>;
      next_cursor?: string;
      error?: { message?: string };
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new AppError(
        `Cloudinary list returned a non-JSON response (HTTP ${response.status}).`,
        "CLOUDINARY_LIST_FAILED",
      );
    }
    if (!response.ok || body.error) {
      throw new AppError(
        `Cloudinary list failed: ${body.error?.message ?? `HTTP ${response.status}`}`,
        "CLOUDINARY_LIST_FAILED",
        response.status === 401
          ? "Check cloudinary.apiKey/apiSecret (Admin API uses the same API key/secret)."
          : undefined,
      );
    }
    const resources = Array.isArray(body.resources) ? body.resources : [];
    return {
      resourceType,
      count: resources.length,
      nextCursor: body.next_cursor || undefined,
      assets: resources.map((r) => ({
        publicId: String(r.public_id ?? ""),
        format: r.format ? String(r.format) : undefined,
        resourceType: (r.resource_type as ResourceType | undefined) ?? resourceType,
        type: r.type ? String(r.type) : undefined,
        bytes: typeof r.bytes === "number" ? r.bytes : undefined,
        width: typeof r.width === "number" ? r.width : undefined,
        height: typeof r.height === "number" ? r.height : undefined,
        createdAt: r.created_at ? String(r.created_at) : undefined,
        url: r.url ? String(r.url) : undefined,
        secureUrl: r.secure_url ? String(r.secure_url) : undefined,
      })),
    };
  }

  async remove(publicId: string, resourceType: ResourceType = "image"): Promise<void> {
    const creds = this.requireCredentials();
    const params: Record<string, string | undefined> = {
      timestamp: timestamp(),
      public_id: publicId,
      invalidate: "true",
    };
    const signature = sign(params, creds.apiSecret);
    const form = new FormData();
    this.appendParams(form, creds.apiKey, params, signature);

    const response = await fetch(this.endpoint(resourceType, "destroy", creds), {
      method: "POST",
      body: form,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AppError(
        `Cloudinary delete failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
        "CLOUDINARY_DELETE_FAILED",
      );
    }
  }
}

export function assertProviderCredentials(
  provider: MediaProvider,
): asserts provider is MediaProvider {
  if (!provider.isConfigured()) {
    throw new AppError("Media provider is not configured.", "PROVIDER_NOT_CONFIGURED");
  }
}
