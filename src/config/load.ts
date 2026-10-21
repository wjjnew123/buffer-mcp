import fs from "node:fs";
import path from "node:path";
import {
  SECRET_PATHS,
  configSchema,
  DEFAULT_CONFIG,
  type ResolvedConfig,
} from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface CliOverrides {
  transportMode?: "stdio" | "http" | "both";
  host?: string;
  port?: number;
  dryRun?: boolean;
  allowDestructive?: boolean;
}

export interface LoadOptions {
  configPath?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  cli?: CliOverrides;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  configPath: string;
  fileExists: boolean;
  env: NodeJS.ProcessEnv;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? deepMerge(out[key], value)
      : value;
  }
  return out as T;
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function bool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

function csv(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export function parseCloudinaryUrl(
  raw: string | undefined,
): CloudinaryCredentials | null {
  if (!raw) return null;
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@([^/?#]+)/.exec(raw.trim());
  if (!match) return null;
  return {
    apiKey: decodeURIComponent(match[1]),
    apiSecret: decodeURIComponent(match[2]),
    cloudName: decodeURIComponent(match[3]),
  };
}

function envPatch(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const buffer: Record<string, unknown> = {};
  if (env.BUFFER_API_URL) buffer.apiUrl = env.BUFFER_API_URL;
  if (env.BUFFER_API_KEY) buffer.apiKey = env.BUFFER_API_KEY;
  if (env.BUFFER_TIMEOUT_MS) buffer.timeoutMs = num(env.BUFFER_TIMEOUT_MS);
  if (env.BUFFER_RETRIES) buffer.retries = num(env.BUFFER_RETRIES);
  if (env.BUFFER_ORGANIZATION_ID) buffer.organizationId = env.BUFFER_ORGANIZATION_ID;
  const channels = csv(env.BUFFER_DEFAULT_CHANNEL_IDS);
  if (channels) buffer.defaultChannelIds = channels;
  if (Object.keys(buffer).length) patch.buffer = buffer;

  const scheduling: Record<string, unknown> = {};
  if (env.BUFFER_MODE) scheduling.mode = env.BUFFER_MODE;
  if (env.BUFFER_TIMEZONE) scheduling.timezone = env.BUFFER_TIMEZONE;
  if (Object.keys(scheduling).length) patch.scheduling = scheduling;

  const cloudinary: Record<string, unknown> = {};
  const fromUrl = parseCloudinaryUrl(env.CLOUDINARY_URL);
  if (fromUrl) {
    cloudinary.cloudName = fromUrl.cloudName;
    cloudinary.apiKey = fromUrl.apiKey;
    cloudinary.apiSecret = fromUrl.apiSecret;
  }
  if (env.CLOUDINARY_CLOUD_NAME) cloudinary.cloudName = env.CLOUDINARY_CLOUD_NAME;
  if (env.CLOUDINARY_API_KEY) cloudinary.apiKey = env.CLOUDINARY_API_KEY;
  if (env.CLOUDINARY_API_SECRET) cloudinary.apiSecret = env.CLOUDINARY_API_SECRET;
  if (env.CLOUDINARY_FOLDER) cloudinary.folder = env.CLOUDINARY_FOLDER;
  if (Object.keys(cloudinary).length) patch.cloudinary = cloudinary;

  const safety: Record<string, unknown> = {};
  const dryRun = bool(env.BUFFER_DRY_RUN);
  if (dryRun !== undefined) safety.dryRun = dryRun;
  const destructive = bool(env.BUFFER_ALLOW_DESTRUCTIVE);
  if (destructive !== undefined) safety.allowDestructive = destructive;
  if (Object.keys(safety).length) patch.safety = safety;

  const transport: Record<string, unknown> = {};
  if (env.MCP_TRANSPORT) transport.mode = env.MCP_TRANSPORT;
  const http: Record<string, unknown> = {};
  if (env.MCP_HTTP_HOST) http.host = env.MCP_HTTP_HOST;
  if (env.MCP_HTTP_PORT) http.port = num(env.MCP_HTTP_PORT);
  if (env.MCP_HTTP_ALLOW_WRITES) http.allowWrites = bool(env.MCP_HTTP_ALLOW_WRITES);
  if (env.MCP_HTTP_STATELESS) http.stateless = bool(env.MCP_HTTP_STATELESS);
  if (env.MCP_HTTP_TOKEN) http.authToken = env.MCP_HTTP_TOKEN;
  if (Object.keys(http).length) transport.http = http;
  if (Object.keys(transport).length) patch.transport = transport;

  const logging: Record<string, unknown> = {};
  if (env.BUFFER_MCP_LOG_LEVEL) logging.level = env.BUFFER_MCP_LOG_LEVEL;
  if (env.BUFFER_MCP_AUDIT_FILE) logging.auditFile = env.BUFFER_MCP_AUDIT_FILE;
  if (Object.keys(logging).length) patch.logging = logging;

  return patch;
}

function applyCli(
  config: ResolvedConfig,
  cli: CliOverrides | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (cli?.transportMode) patch.transport = { mode: cli.transportMode };
  const http: Record<string, unknown> = {};
  if (cli?.host) http.host = cli.host;
  if (cli?.port) http.port = cli.port;
  if (Object.keys(http).length) {
    patch.transport = { ...(patch.transport as object), http };
  }
  const safety: Record<string, unknown> = {};
  if (cli?.dryRun !== undefined) safety.dryRun = cli.dryRun;
  if (cli?.allowDestructive !== undefined) safety.allowDestructive = cli.allowDestructive;
  if (Object.keys(safety).length) patch.safety = safety;
  return deepMerge(config as unknown, patch) as ResolvedConfig;
}

export function resolveConfigPath(opts: LoadOptions): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  if (opts.configPath === null) return "";
  if (opts.configPath) return path.resolve(cwd, opts.configPath);
  if (env.BUFFER_MCP_CONFIG) return path.resolve(cwd, env.BUFFER_MCP_CONFIG);
  return path.resolve(cwd, "buffer-mcp.config.json");
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const configPath = resolveConfigPath(opts);
  let fileConfig: unknown = {};
  let fileExists = false;

  if (configPath && fs.existsSync(configPath)) {
    fileExists = true;
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new ConfigError(
        `Cannot parse config file: ${configPath}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const merged = deepMerge(
    deepMerge(DEFAULT_CONFIG as unknown, fileConfig),
    envPatch(env),
  ) as ResolvedConfig;
  const withCli = applyCli(merged, opts.cli);
  const parsed = configSchema.safeParse(withCli);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }

  const result: LoadedConfig = {
    config: parsed.data,
    configPath,
    fileExists,
    env,
  };
  assertTransportSafety(result);
  return result;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

export function resolveHttpToken(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const http = config.transport.http;
  if (http.authToken) return http.authToken;
  if (http.authTokenEnv) return env[http.authTokenEnv] ?? "";
  return "";
}

export function assertTransportSafety(loaded: LoadedConfig): void {
  const { config, env } = loaded;
  if (config.transport.mode === "stdio") return;
  const http = config.transport.http;
  if (!isLoopbackHost(http.host) && !resolveHttpToken(config, env)) {
    throw new ConfigError(
      `Refusing to expose the HTTP transport on ${http.host} without authentication.`,
      "Set MCP_HTTP_TOKEN (or transport.http.authToken) before listening on a non-loopback interface.",
    );
  }
}

export function getCredentials(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): CloudinaryCredentials {
  const direct: CloudinaryCredentials = {
    cloudName: config.cloudinary.cloudName,
    apiKey: config.cloudinary.apiKey,
    apiSecret: config.cloudinary.apiSecret,
  };
  const fromUrl = parseCloudinaryUrl(env[config.cloudinary.urlEnv]);
  return {
    cloudName: direct.cloudName || fromUrl?.cloudName || "",
    apiKey: direct.apiKey || fromUrl?.apiKey || "",
    apiSecret: direct.apiSecret || fromUrl?.apiSecret || "",
  };
}

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export function publicConfig(config: ResolvedConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, any>;
  clone.buffer.apiKey = maskSecret(clone.buffer.apiKey);
  clone.cloudinary.apiKey = maskSecret(clone.cloudinary.apiKey);
  clone.cloudinary.apiSecret = maskSecret(clone.cloudinary.apiSecret);
  if (clone.transport?.http?.authToken) {
    clone.transport.http.authToken = maskSecret(clone.transport.http.authToken);
  }
  clone._secretPaths = SECRET_PATHS;
  return clone;
}
