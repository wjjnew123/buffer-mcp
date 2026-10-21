import fs from "node:fs";
import path from "node:path";
import {
  SECRET_PATHS,
  configSchema,
  DEFAULT_CONFIG,
  type ResolvedConfig,
} from "./schema.js";
import { ConfigError, deepMerge } from "./load.js";

export function readRawConfig(configPath: string): Record<string, unknown> {
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`Config file must contain a JSON object: ${configPath}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      `Cannot read config file: ${configPath}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function collectPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...collectPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

export interface ApplyPatchOptions {
  configPath: string;
  patch: Record<string, unknown>;
  allowSecretWrite: boolean;
}

export function applyConfigPatch(opts: ApplyPatchOptions): {
  config: ResolvedConfig;
  written: Record<string, unknown>;
} {
  const { configPath, patch, allowSecretWrite } = opts;
  if (!configPath) {
    throw new ConfigError(
      "No config file path is configured; cannot persist settings.",
      "Set BUFFER_MCP_CONFIG or run with --config <path>.",
    );
  }

  const touched = collectPaths(patch);
  const forbidden = touched.filter((p) =>
    SECRET_PATHS.some((s) => p === s || p.startsWith(`${s}.`)),
  );
  if (forbidden.length && !allowSecretWrite) {
    throw new ConfigError(
      `Refusing to write secrets: ${forbidden.join(", ")}`,
      "Set safety.allowSecretWrite=true to permit writing Cloudinary/Buffer credentials to the config file.",
    );
  }

  const current = readRawConfig(configPath);
  const merged = deepMerge(current, patch);
  const parsed = configSchema.safeParse(deepMerge(DEFAULT_CONFIG as unknown, merged));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* Windows / restricted fs: ignore */
  }

  return { config: parsed.data, written: merged };
}

export function resetConfig(configPath: string): void {
  if (!configPath) {
    throw new ConfigError("No config file path is configured.");
  }
  if (fs.existsSync(configPath)) fs.rmSync(configPath);
}
