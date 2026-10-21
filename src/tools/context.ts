import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedConfig } from "../config/schema.js";
import type { BufferClient } from "../core/client.js";
import { AppError, describeError } from "../core/errors.js";
import { redactValue, type Logger } from "../core/logger.js";
import type { MediaProvider } from "../providers/types.js";

export interface ToolContext {
  config: ResolvedConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  client: BufferClient;
  provider: MediaProvider | null;
  transport: "stdio" | "http";
}

export type ToolResult = CallToolResult;

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function fail(err: unknown): ToolResult {
  const described = describeError(err);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: described.message,
            code: described.code,
            ...(described.hint ? { hint: described.hint } : {}),
            ...(described.details ? { details: redactValue(described.details) } : {}),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

export interface GuardOptions {
  action: string;
  destructive?: boolean;
  confirm?: string;
  expected: string;
  payload?: unknown;
}

export function guardWrite(ctx: ToolContext, opts: GuardOptions): void {
  if (ctx.transport === "http" && !ctx.config.transport.http.allowWrites) {
    throw new AppError(
      "Write operations are disabled for the HTTP transport.",
      "HTTP_TRANSPORT_READONLY",
      "Set transport.http.allowWrites=true (or MCP_HTTP_ALLOW_WRITES=true) to enable writes over HTTP.",
    );
  }
  if (opts.destructive && !ctx.config.safety.allowDestructive) {
    throw new AppError(
      `Destructive action '${opts.action}' is disabled.`,
      "DESTRUCTIVE_DISABLED",
      "Set safety.allowDestructive=true to enable delete/update operations.",
    );
  }
  if (ctx.config.safety.requireConfirmToken) {
    if (!opts.confirm) {
      throw new AppError(
        `Confirmation required for '${opts.action}'.`,
        "CONFIRM_REQUIRED",
        `Show the payload to the user and call again with confirm="${opts.expected}".`,
      );
    }
    if (opts.confirm !== opts.expected) {
      throw new AppError(
        `Invalid confirmation token for '${opts.action}'.`,
        "CONFIRM_MISMATCH",
        `Expected confirm="${opts.expected}".`,
      );
    }
  }
  audit(ctx, opts.action, opts.payload);
}

function audit(ctx: ToolContext, action: string, payload: unknown): void {
  const file = ctx.config.logging.auditFile;
  if (!file) return;
  try {
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(
      target,
      `${JSON.stringify({
        time: new Date().toISOString(),
        transport: ctx.transport,
        action,
        payload: redactValue(payload),
      })}\n`,
      "utf8",
    );
  } catch (err) {
    ctx.logger.warn("Failed to write audit log", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function requireProvider(ctx: ToolContext): MediaProvider {
  if (!ctx.provider) {
    throw new AppError(
      "No media provider is configured.",
      "PROVIDER_NOT_CONFIGURED",
      "Enable cloudinary in the config file.",
    );
  }
  return ctx.provider;
}

export function detectService(channel: { service?: string; type?: string }): string {
  return (channel.service ?? channel.type ?? "").toLowerCase();
}
