import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../core/errors.js";
import { deepMerge } from "../config/load.js";
import { CREATE_POST, DELETE_POST, EDIT_POST, POST, POSTS } from "../core/documents.js";
import { readMp4Info } from "../media/mp4.js";
import { mediaKindOf, probeUrl } from "../media/probe.js";
import { hasBlockingIssues, validatePost, type AssetInfo, type ValidationIssue } from "../validate/platform.js";
import {
  fail,
  guardWrite,
  ok,
  requireProvider,
  type ToolContext,
} from "./context.js";
import { fetchChannels, resolveOrganizationId, type ChannelRecord } from "./shared.js";

const MODES = ["addToQueue", "shareNext", "shareNow", "customScheduled"] as const;
const STATUSES = [
  "draft",
  "error",
  "needs_approval",
  "scheduled",
  "sending",
  "sent",
] as const;

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv|flv|wmv|mpe?g)$/i;

interface PostActionPayload {
  __typename: string;
  post?: {
    id: string;
    status: string;
    dueAt?: string | null;
    channelId: string;
    text: string;
  };
  message?: string;
}

interface PostRecord {
  id: string;
  text: string;
  status: string;
  dueAt?: string | null;
  sentAt?: string | null;
  channelId: string;
  channelService: string;
  schedulingType?: string | null;
  assets: Array<Record<string, unknown>>;
  error?: { message: string } | null;
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function guessKind(value: string): "image" | "video" | "unknown" {
  if (IMAGE_EXT.test(value)) return "image";
  if (VIDEO_EXT.test(value)) return "video";
  return "unknown";
}

function assetInput(asset: AssetInfo): Record<string, unknown> {
  if (asset.kind === "video") return { video: { url: asset.url } };
  if (asset.kind === "document") {
    throw new AppError(
      "Document assets are not supported by this tool.",
      "UNSUPPORTED_ASSET",
      "Use image or video media.",
    );
  }
  return { image: { url: asset.url } };
}

function parsePayload(payload: PostActionPayload): {
  ok: boolean;
  post?: PostActionPayload["post"];
  message?: string;
} {
  if (payload.__typename === "PostActionSuccess" && payload.post) {
    return { ok: true, post: payload.post };
  }
  return { ok: false, message: payload.message ?? payload.__typename };
}

export function registerPostTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "buffer_list_posts",
    {
      title: "List posts",
      description:
        "List posts for an organization with optional channel, status, and due-date filters. Returns the newest page by default.",
      inputSchema: {
        organizationId: z.string().optional(),
        channelIds: z.array(z.string()).optional(),
        status: z.array(z.enum(STATUSES)).optional(),
        dueAfter: z.string().optional().describe("ISO 8601 lower bound for dueAt."),
        dueBefore: z.string().optional().describe("ISO 8601 upper bound for dueAt."),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional().describe("Pagination cursor."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ organizationId, channelIds, status, dueAfter, dueBefore, limit, after }) => {
      try {
        const orgId = await resolveOrganizationId(ctx, organizationId);
        const filter: Record<string, unknown> = {};
        if (channelIds?.length) filter.channelIds = channelIds;
        if (status?.length) filter.status = status;
        if (dueAfter || dueBefore) {
          filter.dueAt = {
            ...(dueAfter ? { start: dueAfter } : {}),
            ...(dueBefore ? { end: dueBefore } : {}),
          };
        }
        const data = await ctx.client.graphql<{
          posts: {
            edges: Array<{ cursor: string; node: PostRecord }>;
            pageInfo: { hasNextPage: boolean; endCursor?: string | null };
          };
        }>(POSTS, {
          input: {
            organizationId: orgId,
            ...(Object.keys(filter).length ? { filter } : {}),
          },
          first: limit ?? 20,
          after: after ?? null,
        });
        return ok({
          organizationId: orgId,
          count: data.posts.edges.length,
          posts: data.posts.edges.map((e) => e.node),
          pageInfo: data.posts.pageInfo,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_get_post",
    {
      title: "Get post",
      description: "Fetch a single post with assets, status and any publishing error.",
      inputSchema: {
        postId: z.string(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ postId }) => {
      try {
        const data = await ctx.client.graphql<{ post: PostRecord }>(POST, {
          input: { id: postId },
        });
        return ok(data.post);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_create_post",
    {
      title: "Create a Buffer post",
      description:
        "Create one post per channel. Media can be local paths (uploaded through Cloudinary) or HTTPS URLs. Runs platform validation first; use dryRun to preview the payload without writing.",
      inputSchema: {
        text: z.string().default(""),
        channelIds: z
          .array(z.string())
          .optional()
          .describe("Target channels. Defaults to buffer.defaultChannelIds."),
        media: z
          .array(z.string())
          .optional()
          .describe("Local file paths or HTTPS URLs, in order."),
        mode: z.enum(MODES).optional(),
        dueAt: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp, required when mode is customScheduled."),
        metadata: z
          .record(z.record(z.unknown()))
          .optional()
          .describe(
            'Per-service metadata overrides, e.g. { "youtube": { "privacy": "unlisted" } }.',
          ),
        dryRun: z.boolean().optional(),
        confirm: z.string().optional().describe('Must be "create" unless dryRun is true.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ text, channelIds, media, mode, dueAt, metadata, dryRun, confirm }) => {
      try {
        const targets = channelIds?.length
          ? channelIds
          : ctx.config.buffer.defaultChannelIds;
        if (!targets.length) {
          throw new AppError(
            "No target channels.",
            "NO_CHANNELS",
            "Pass channelIds or set buffer.defaultChannelIds in the config.",
          );
        }

        const effectiveMode = mode ?? ctx.config.scheduling.mode;
        if (effectiveMode === "customScheduled" && !dueAt) {
          throw new AppError(
            "mode customScheduled requires dueAt.",
            "MISSING_DUE_AT",
          );
        }
        if (dueAt && Number.isNaN(Date.parse(dueAt))) {
          throw new AppError(`dueAt is not a valid ISO 8601 timestamp: ${dueAt}`, "INVALID_DUE_AT");
        }

        const isDryRun = dryRun ?? ctx.config.safety.dryRun;
        if (!isDryRun) {
          guardWrite(ctx, {
            action: "buffer_create_post",
            expected: "create",
            confirm,
            payload: { channelIds: targets, mode: effectiveMode, dueAt, mediaCount: media?.length ?? 0 },
          });
        }

        const orgId = await resolveOrganizationId(ctx);
        const channels = await fetchChannels(ctx, orgId);
        const byId = new Map(channels.map((c) => [c.id, c]));
        const missing = targets.filter((id) => !byId.has(id));
        if (missing.length) {
          throw new AppError(
            `Unknown channel id(s): ${missing.join(", ")}`,
            "UNKNOWN_CHANNEL",
            "Call buffer_list_channels to get valid ids.",
          );
        }

        const { assets, uploads } = await buildAssets(ctx, media ?? [], isDryRun);

        const perChannel: Array<{
          channel: ChannelRecord;
          metadata: Record<string, unknown>;
          issues: ValidationIssue[];
          payload: Record<string, unknown>;
        }> = [];

        for (const id of targets) {
          const channel = byId.get(id) as ChannelRecord;
          const service = channel.service;
          const metadataForService = deepMerge(
            ctx.config.platforms[service] ?? {},
            metadata?.[service] ?? {},
          ) as Record<string, unknown>;

          const issues = validatePost({
            service,
            text,
            assets,
            metadata: metadataForService,
            config: ctx.config,
          });

          const payload: Record<string, unknown> = {
            channelId: id,
            text,
            schedulingType: ctx.config.scheduling.schedulingType,
            mode: effectiveMode,
            needsApproval: ctx.config.scheduling.needsApproval,
            assets: assets.map(assetInput),
            metadata: { [service]: metadataForService },
            ...(dueAt ? { dueAt } : {}),
          };

          perChannel.push({ channel, metadata: metadataForService, issues, payload });
        }

        const blocking = perChannel.filter((p) => hasBlockingIssues(p.issues));
        if (blocking.length) {
          return ok({
            created: false,
            reason: "validation_failed",
            results: perChannel.map((p) => ({
              channelId: p.channel.id,
              service: p.channel.service,
              issues: p.issues,
            })),
          });
        }

        if (isDryRun) {
          return ok({
            dryRun: true,
            uploads,
            results: perChannel.map((p) => ({
              channelId: p.channel.id,
              service: p.channel.service,
              issues: p.issues,
              payload: p.payload,
            })),
          });
        }

        const results: unknown[] = [];
        for (const entry of perChannel) {
          const data = await ctx.client.graphql<{ createPost: PostActionPayload }>(
            CREATE_POST,
            { input: entry.payload },
          );
          const parsed = parsePayload(data.createPost);
          results.push({
            channelId: entry.channel.id,
            service: entry.channel.service,
            success: parsed.ok,
            postId: parsed.post?.id,
            status: parsed.post?.status,
            dueAt: parsed.post?.dueAt,
            dueAtLocal: parsed.post?.dueAt
              ? new Date(parsed.post.dueAt).toLocaleString("en-US", {
                  timeZone: entry.channel.timezone || ctx.config.scheduling.timezone,
                })
              : undefined,
            error: parsed.message,
            warnings: entry.issues.filter((i) => i.severity === "warn"),
          });
        }

        return ok({ created: results.some((r) => (r as { success: boolean }).success), uploads, results });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_update_post",
    {
      title: "Update a post",
      description:
        "Edit the text, due date, mode or metadata of an existing draft/scheduled post. Requires safety.allowDestructive=true and confirm equal to the post id.",
      inputSchema: {
        postId: z.string(),
        text: z.string().optional(),
        dueAt: z.string().optional(),
        mode: z.enum(MODES).optional(),
        metadata: z.record(z.record(z.unknown())).optional(),
        confirm: z.string().optional().describe("Must equal postId."),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ postId, text, dueAt, mode, metadata, confirm }) => {
      try {
        guardWrite(ctx, {
          action: "buffer_update_post",
          destructive: true,
          expected: postId,
          confirm,
          payload: { postId, text, dueAt, mode },
        });
        if (dueAt && Number.isNaN(Date.parse(dueAt))) {
          throw new AppError(`dueAt is not a valid ISO 8601 timestamp: ${dueAt}`, "INVALID_DUE_AT");
        }
        const existing = await ctx.client.graphql<{ post: PostRecord }>(POST, {
          input: { id: postId },
        });
        const service = existing.post.channelService;
        const metadataForService = metadata?.[service]
          ? deepMerge(ctx.config.platforms[service] ?? {}, metadata[service]) 
          : undefined;

        const input: Record<string, unknown> = { id: postId };
        if (text !== undefined) input.text = text;
        if (dueAt !== undefined) input.dueAt = dueAt;
        if (mode !== undefined) input.mode = mode;
        if (metadataForService) input.metadata = { [service]: metadataForService };

        const data = await ctx.client.graphql<{ editPost: PostActionPayload }>(EDIT_POST, {
          input,
        });
        const parsed = parsePayload(data.editPost);
        return ok({
          success: parsed.ok,
          postId: parsed.post?.id ?? postId,
          status: parsed.post?.status,
          dueAt: parsed.post?.dueAt,
          error: parsed.message,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_delete_post",
    {
      title: "Delete a post",
      description:
        "Delete a post by id. Requires safety.allowDestructive=true and confirm equal to the post id.",
      inputSchema: {
        postId: z.string(),
        confirm: z.string().optional().describe("Must equal postId."),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ postId, confirm }) => {
      try {
        guardWrite(ctx, {
          action: "buffer_delete_post",
          destructive: true,
          expected: postId,
          confirm,
          payload: { postId },
        });
        const data = await ctx.client.graphql<{
          deletePost: { __typename: string; id?: string; message?: string };
        }>(DELETE_POST, { input: { id: postId } });
        const payload = data.deletePost;
        if (payload.__typename === "DeletePostSuccess") {
          return ok({ deleted: true, postId: payload.id ?? postId });
        }
        return ok({
          deleted: false,
          postId,
          error: payload.message ?? payload.__typename,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

async function buildAssets(
  ctx: ToolContext,
  media: string[],
  dryRun: boolean,
): Promise<{ assets: AssetInfo[]; uploads: unknown[] }> {
  const assets: AssetInfo[] = [];
  const uploads: unknown[] = [];

  for (const item of media) {
    if (isUrl(item)) {
      const probe = await probeUrl(item, { timeoutMs: ctx.config.media.probeTimeoutMs });
      if (ctx.config.media.requireHttps && !probe.https) {
        throw new AppError(
          `Media URL must use HTTPS: ${item}`,
          "MEDIA_NOT_HTTPS",
          "Upload the file to Cloudinary and use its secure_url.",
        );
      }
      if (!probe.ok && ctx.config.media.blockOnProbeFailure) {
        throw new AppError(
          `Media URL is not readable: ${item}`,
          "MEDIA_UNREADABLE",
          probe.error,
        );
      }
      const kindFromType = mediaKindOf(probe.contentType);
      const resolvedKind = kindFromType === "unknown" ? guessKind(item) : kindFromType;
      const kind: AssetInfo["kind"] = resolvedKind === "unknown" ? "image" : resolvedKind;
      assets.push({ kind, url: item });
      uploads.push({ source: item, reused: true, probe });
      continue;
    }

    const localPath = path.resolve(item);
    const kind = guessKind(localPath);
    const info = kind === "video" ? await readMp4Info(localPath) : null;

    if (dryRun) {
      assets.push({
        kind: kind === "unknown" ? "image" : kind,
        url: `file://${localPath}`,
        width: info?.width,
        height: info?.height,
        durationMs: info?.durationMs,
      });
      uploads.push({ source: localPath, skipped: "dryRun", info });
      continue;
    }

    const provider = requireProvider(ctx);
    if (!provider.isConfigured()) {
      throw new AppError(
        "Cloudinary is not configured; cannot upload local media.",
        "CLOUDINARY_NOT_CONFIGURED",
        "Set cloudinary credentials, or pass HTTPS URLs in media.",
      );
    }
    const result = await provider.upload({ path: localPath }, {});
    assets.push({
      kind: result.resourceType === "video" ? "video" : "image",
      url: result.secureUrl,
      width: result.width,
      height: result.height,
      durationMs: result.durationMs,
    });
    uploads.push(result);
  }

  return { assets, uploads };
}
