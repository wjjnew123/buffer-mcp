import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_CONFIG, type ResolvedConfig } from "../config/schema.js";
import { publicConfig } from "../config/load.js";
import { applyConfigPatch, resetConfig } from "../config/store.js";
import { ok, fail, guardWrite, type ToolContext } from "./context.js";

function replaceConfig(ctx: ToolContext, next: ResolvedConfig): void {
  const target = ctx.config as Record<string, unknown>;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

export function registerConfigTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "buffer_get_config",
    {
      title: "Get effective configuration",
      description:
        "Return the merged configuration (defaults < config file < environment < CLI). Secrets are masked. Use this to discover the active settings before making changes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      ok({
        configPath: ctx.configPath || null,
        fileExists: Boolean(ctx.configPath && fs.existsSync(ctx.configPath)),
        transport: ctx.transport,
        bufferKeyConfigured: ctx.client.hasApiKey(),
        mediaProviderConfigured: ctx.provider?.isConfigured() ?? false,
        config: publicConfig(ctx.config),
      }),
  );

  server.registerTool(
    "buffer_set_config",
    {
      title: "Update configuration",
      description:
        "Deep-merge a JSON patch into the config file and persist it. Only non-secret settings are writable unless safety.allowSecretWrite is true. Returns the updated, masked configuration.",
      inputSchema: {
        patch: z
          .record(z.unknown())
          .describe(
            'Partial config object, e.g. { "scheduling": { "mode": "shareNext" }, "platforms": { "youtube": { "categoryId": "28" } } }',
          ),
        confirm: z
          .string()
          .optional()
          .describe('Must be "config" when safety.requireConfirmToken is enabled.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ patch, confirm }) => {
      try {
        guardWrite(ctx, {
          action: "set_config",
          expected: "config",
          confirm,
          payload: patch,
        });
        const result = applyConfigPatch({
          configPath: ctx.configPath,
          patch,
          allowSecretWrite: ctx.config.safety.allowSecretWrite,
        });
        replaceConfig(ctx, result.config);
        return ok({
          configPath: ctx.configPath,
          config: publicConfig(ctx.config),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_reset_config",
    {
      title: "Reset configuration",
      description:
        "Delete the persisted config file and fall back to defaults plus environment variables. Requires safety.allowDestructive=true and confirm=\"reset\".",
      inputSchema: {
        confirm: z.string().optional().describe('Must be "reset".'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ confirm }) => {
      try {
        guardWrite(ctx, {
          action: "reset_config",
          destructive: true,
          expected: "reset",
          confirm,
        });
        resetConfig(ctx.configPath);
        replaceConfig(ctx, JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ResolvedConfig);
        return ok({ reset: true, configPath: ctx.configPath });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
