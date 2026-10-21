import { z } from "zod";

const httpSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(8787),
    path: z.string().default("/mcp"),
    authToken: z.string().default(""),
    authTokenEnv: z.string().nullable().default("MCP_HTTP_TOKEN"),
    corsOrigins: z.array(z.string()).default([]),
    sessionTtlMs: z.number().int().positive().default(1_800_000),
    allowWrites: z.boolean().default(false),
    maxBodyBytes: z.number().int().positive().default(1_048_576),
    trustProxy: z.boolean().default(false),
    allowedIps: z.array(z.string()).default([]),
    stateless: z.boolean().default(false),
    rateLimit: z
      .object({
        enabled: z.boolean().default(true),
        windowMs: z.number().int().positive().default(60_000),
        max: z.number().int().positive().default(120),
      })
      .default({}),
  })
  .default({});

export const bufferSchema = z
  .object({
    apiUrl: z.string().url().default("https://api.buffer.com"),
    apiKey: z.string().default(""),
    apiKeyEnv: z.string().default("BUFFER_API_KEY"),
    timeoutMs: z.number().int().positive().default(30_000),
    retries: z.number().int().min(0).max(5).default(2),
    retryDelayMs: z.number().int().min(0).default(500),
    organizationId: z.string().nullable().default(null),
    defaultChannelIds: z.array(z.string()).default([]),
  })
  .default({});

const schedulingSchema = z
  .object({
    mode: z
      .enum(["addToQueue", "shareNext", "shareNow", "customScheduled"])
      .default("addToQueue"),
    schedulingType: z.enum(["automatic", "notification"]).default("automatic"),
    needsApproval: z.boolean().default(false),
    timezone: z.string().default("Asia/Shanghai"),
  })
  .default({});

const platformsSchema = z
  .object({
    facebook: z
      .record(z.unknown())
      .default({ type: "post" }),
    instagram: z
      .record(z.unknown())
      .default({ type: "post", shouldShareToFeed: true }),
    youtube: z
      .record(z.unknown())
      .default({
        privacy: "public",
        categoryId: "2",
        madeForKids: false,
        notifySubscribers: true,
        license: "youtube",
      }),
  })
  .catchall(z.record(z.unknown()))
  .default({});

const cloudinarySchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: z.enum(["cloudinary"]).default("cloudinary"),
    cloudName: z.string().default(""),
    apiKey: z.string().default(""),
    apiSecret: z.string().default(""),
    urlEnv: z.string().default("CLOUDINARY_URL"),
    folder: z.string().default("buffer"),
    resourceType: z.enum(["auto", "image", "video"]).default("auto"),
    overwrite: z.boolean().default(false),
    chunkThresholdMb: z.number().int().positive().default(100),
    returnVariants: z.boolean().default(true),
  })
  .default({});

const mediaSchema = z
  .object({
    requireHttps: z.boolean().default(true),
    probeTimeoutMs: z.number().int().positive().default(15_000),
    maxBytes: z.number().int().positive().default(524_288_000),
    blockOnProbeFailure: z.boolean().default(true),
  })
  .default({});

const validationSchema = z
  .object({
    enforceTextLimits: z.boolean().default(true),
    rejectYoutubeHorizontalShort: z.boolean().default(true),
    warnOnly: z.boolean().default(false),
  })
  .default({});

const safetySchema = z
  .object({
    allowDestructive: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    requireConfirmToken: z.boolean().default(true),
    allowSecretWrite: z.boolean().default(false),
  })
  .default({});

const loggingSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    redact: z.boolean().default(true),
    auditFile: z.string().nullable().default(null),
  })
  .default({});

const transportSchema = z
  .object({
    mode: z.enum(["stdio", "http", "both"]).default("stdio"),
    http: httpSchema,
  })
  .default({});

export const configSchema = z.object({
  buffer: bufferSchema,
  scheduling: schedulingSchema,
  platforms: platformsSchema,
  cloudinary: cloudinarySchema,
  media: mediaSchema,
  validation: validationSchema,
  safety: safetySchema,
  logging: loggingSchema,
  transport: transportSchema,
});

export type ResolvedConfig = z.infer<typeof configSchema>;
export type HttpConfig = z.infer<typeof httpSchema>;
export type CloudinaryConfig = z.infer<typeof cloudinarySchema>;

export const DEFAULT_CONFIG: ResolvedConfig = configSchema.parse({});

export const SECRET_PATHS: readonly string[] = [
  "buffer.apiKey",
  "cloudinary.apiKey",
  "cloudinary.apiSecret",
  "transport.http.authToken",
];
