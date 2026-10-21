import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../core/errors.js";
import { readMp4Info } from "../media/mp4.js";
import { mediaKindOf, probeUrl } from "../media/probe.js";
import { validatePost, type AssetInfo, type ValidationIssue } from "../validate/platform.js";
import { checkText } from "../validate/text.js";
import {
  fail,
  guardWrite,
  ok,
  requireProvider,
  type ToolContext,
} from "./context.js";
import { fetchChannels, resolveOrganizationId } from "./shared.js";

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv|flv|wmv|mpe?g)$/i;

const resourceTypeSchema = z.enum(["auto", "image", "video"]).optional();

function guessKind(value: string): "image" | "video" | "unknown" {
  if (IMAGE_EXT.test(value)) return "image";
  if (VIDEO_EXT.test(value)) return "video";
  return "unknown";
}

async function inspect(
  source: { url?: string; path?: string },
  timeoutMs: number,
): Promise<AssetInfo & { probe?: unknown }> {
  if (source.url) {
    const probe = await probeUrl(source.url, { timeoutMs });
    const kind = mediaKindOf(probe.contentType);
    return {
      kind: kind === "unknown" ? (guessKind(source.url) as AssetInfo["kind"]) : kind,
      url: source.url,
      probe,
    };
  }
  if (!source.path) throw new AppError("Provide url or path.", "INVALID_INPUT");
  const kind = guessKind(source.path);
  const base: AssetInfo & { probe?: unknown } = {
    kind: kind === "unknown" ? "image" : kind,
    url: source.path,
  };
  if (kind === "video") {
    const info = await readMp4Info(path.resolve(source.path));
    if (info) {
      base.width = info.width;
      base.height = info.height;
      base.durationMs = info.durationMs;
      base.probe = { local: true, ...info };
    }
  }
  return base;
}

export function registerMediaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "cloudinary_upload",
    {
      title: "Upload media to Cloudinary",
      description:
        "Upload a local file (or import a remote URL) through the built-in Cloudinary credentials and return the public HTTPS delivery URL plus metadata. This is the only supported upload path; credentials never leave this process.",
      inputSchema: {
        path: z.string().optional().describe("Absolute or relative local file path."),
        url: z
          .string()
          .optional()
          .describe("Remote URL for Cloudinary to fetch instead of a local file."),
        resourceType: resourceTypeSchema.describe(
          "auto (default), image, or video. auto lets Cloudinary detect the type.",
        ),
        folder: z.string().optional().describe("Cloudinary folder override."),
        publicId: z.string().optional().describe("Cloudinary public_id override."),
        confirm: z.string().optional().describe('Must be "upload".'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path: filePath, url, resourceType, folder, publicId, confirm }) => {
      try {
        guardWrite(ctx, {
          action: "cloudinary_upload",
          expected: "upload",
          confirm,
          payload: { path: filePath, url, resourceType, folder, publicId },
        });
        const provider = requireProvider(ctx);
        if (!provider.isConfigured()) {
          throw new AppError(
            "Cloudinary is not configured.",
            "CLOUDINARY_NOT_CONFIGURED",
            "Set cloudinary.cloudName/apiKey/apiSecret (or CLOUDINARY_URL / CLOUDINARY_* env vars).",
          );
        }
        const result = await provider.upload(
          { path: filePath, url },
          { resourceType, folder, publicId },
        );
        const variants = ctx.config.cloudinary.returnVariants
          ? provider.variants(result.publicId, result.resourceType)
          : undefined;
        return ok({ ...result, variants });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cloudinary_upload_batch",
    {
      title: "Upload multiple media files",
      description:
        "Upload several local files or URLs sequentially, returning per-item results and failures. Maximum 20 items.",
      inputSchema: {
        paths: z.array(z.string()).max(20).optional(),
        urls: z.array(z.string()).max(20).optional(),
        resourceType: resourceTypeSchema,
        folder: z.string().optional(),
        confirm: z.string().optional().describe('Must be "upload".'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ paths, urls, resourceType, folder, confirm }) => {
      try {
        const items = [
          ...(paths ?? []).map((p) => ({ path: p })),
          ...(urls ?? []).map((u) => ({ url: u })),
        ];
        if (!items.length) throw new AppError("Provide paths and/or urls.", "INVALID_INPUT");
        guardWrite(ctx, {
          action: "cloudinary_upload_batch",
          expected: "upload",
          confirm,
          payload: { count: items.length, resourceType, folder },
        });
        const provider = requireProvider(ctx);
        if (!provider.isConfigured()) {
          throw new AppError("Cloudinary is not configured.", "CLOUDINARY_NOT_CONFIGURED");
        }
        const results: unknown[] = [];
        const failures: unknown[] = [];
        for (const item of items) {
          try {
            const result = await provider.upload(item, { resourceType, folder });
            results.push(result);
          } catch (err) {
            failures.push({
              source: item,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return ok({ uploaded: results, failures });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cloudinary_link",
    {
      title: "Build a Cloudinary delivery URL",
      description:
        "Construct a public delivery URL for an existing public_id, optionally with a transformation.",
      inputSchema: {
        publicId: z.string(),
        resourceType: z.enum(["image", "video", "raw"]).optional(),
        transformation: z
          .string()
          .optional()
          .describe("Cloudinary transformation string, e.g. c_pad,w_1080,h_1920,b_black"),
        version: z.union([z.string(), z.number()]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ publicId, resourceType, transformation, version }) => {
      try {
        const provider = requireProvider(ctx);
        return ok({
          url: provider.link(publicId, { resourceType, transformation, version }),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cloudinary_variants",
    {
      title: "Generate platform media variants",
      description:
        "Return delivery URLs for common platform aspect ratios (16:9, 1:1, 4:5, 9:16 padded, 9:16 cropped) derived from an existing public_id.",
      inputSchema: {
        publicId: z.string(),
        resourceType: z.enum(["image", "video", "raw"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ publicId, resourceType }) => {
      try {
        const provider = requireProvider(ctx);
        return ok({ variants: provider.variants(publicId, resourceType ?? "video") });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "cloudinary_delete",
    {
      title: "Delete a Cloudinary asset",
      description:
        "Permanently delete an asset by public_id. Requires safety.allowDestructive=true and confirm equal to the public_id.",
      inputSchema: {
        publicId: z.string(),
        resourceType: z.enum(["image", "video", "raw"]).optional(),
        confirm: z.string().optional().describe("Must equal publicId."),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ publicId, resourceType, confirm }) => {
      try {
        guardWrite(ctx, {
          action: "cloudinary_delete",
          destructive: true,
          expected: publicId,
          confirm,
          payload: { publicId, resourceType },
        });
        const provider = requireProvider(ctx);
        await provider.remove(publicId, resourceType ?? "image");
        return ok({ deleted: true, publicId });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "media_probe",
    {
      title: "Probe a media URL",
      description:
        "Check HTTPS, HEAD support, range support, content type and size of a public media URL. Buffer requires an HTTPS URL whose endpoint answers HEAD instead of returning 404.",
      inputSchema: {
        url: z.string().describe("Public media URL to inspect."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const probe = await probeUrl(url, {
          timeoutMs: ctx.config.media.probeTimeoutMs,
        });
        return ok({
          ...probe,
          warnings: [
            !probe.https ? "URL is not HTTPS; Buffer requires HTTPS media." : null,
            !probe.supportsHead && probe.ok
              ? "Endpoint rejects HEAD; Buffer may fail to read the video. Prefer Cloudinary."
              : null,
          ].filter(Boolean),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "media_preflight",
    {
      title: "Preflight media against platform rules",
      description:
        "Validate text and media against the selected channels before creating a post: text limits, required metadata, asset types, and the YouTube Shorts orientation rule.",
      inputSchema: {
        text: z.string().optional(),
        url: z.string().optional(),
        path: z.string().optional(),
        channelIds: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ text, url, path: filePath, channelIds }) => {
      try {
        const asset = await inspect({ url, path: filePath }, ctx.config.media.probeTimeoutMs);
        const issues: Record<string, ValidationIssue[]> = {};
        let channels = [] as Awaited<ReturnType<typeof fetchChannels>>;

        if (channelIds?.length) {
          const orgId = await resolveOrganizationId(ctx);
          const all = await fetchChannels(ctx, orgId);
          channels = all.filter((c) => channelIds.includes(c.id));
        }

        const services = channels.length
          ? channels.map((c) => c.service)
          : ["facebook", "instagram", "youtube"];

        for (const service of services) {
          const metadata = {
            ...(ctx.config.platforms[service] ?? {}),
          } as Record<string, unknown>;
          issues[service] = validatePost({
            service,
            text: text ?? "",
            assets: [asset],
            metadata,
            config: ctx.config,
          });
        }

        return ok({
          asset,
          textChecks: services.map((s) => checkText(text ?? "", s)),
          issues,
          ok: Object.values(issues).every((list) =>
            list.every((i) => i.severity !== "block"),
          ),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
