#!/usr/bin/env node
import { ConfigError, loadConfig, type CliOverrides } from "./config/load.js";
import type { ResolvedConfig } from "./config/schema.js";
import { BufferClient } from "./core/client.js";
import { Logger } from "./core/logger.js";
import { createProvider } from "./providers/index.js";
import { createServer } from "./server.js";
import type { ToolContext } from "./tools/context.js";
import { startHttpTransport } from "./transport/http.js";
import { startStdio } from "./transport/stdio.js";

interface CliArgs extends CliOverrides {
  config?: string;
  help?: boolean;
  version?: boolean;
}

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const inline = argv[index].split("=");
  if (inline.length > 1) return [inline.slice(1).join("="), index];
  const next = argv[index + 1];
  if (next === undefined) throw new ConfigError(`Missing value for ${flag}`);
  return [next, index + 1];
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    switch (flag) {
      case "--config":
      case "-c": {
        const [value, next] = takeValue(argv, i, flag);
        out.config = value;
        i = next;
        break;
      }
      case "--transport": {
        const [value, next] = takeValue(argv, i, flag);
        if (!["stdio", "http", "both"].includes(value)) {
          throw new ConfigError(`Invalid --transport value: ${value}`);
        }
        out.transportMode = value as CliArgs["transportMode"];
        i = next;
        break;
      }
      case "--host": {
        const [value, next] = takeValue(argv, i, flag);
        out.host = value;
        i = next;
        break;
      }
      case "--port": {
        const [value, next] = takeValue(argv, i, flag);
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new ConfigError(`Invalid --port value: ${value}`);
        }
        out.port = port;
        i = next;
        break;
      }
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--allow-destructive":
        out.allowDestructive = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--version":
      case "-v":
        out.version = true;
        break;
      default:
        throw new ConfigError(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

const HELP = `buffer-mcp - Buffer publishing MCP server

Usage:
  buffer-mcp [options]

Options:
  -c, --config <path>        Config file (default: ./buffer-mcp.config.json)
      --transport <mode>     stdio | http | both   (default: from config)
      --host <host>          HTTP bind host        (default: 127.0.0.1)
      --port <port>          HTTP port             (default: 8787)
      --dry-run              Never write to Buffer or Cloudinary
      --allow-destructive    Enable update/delete tools
  -h, --help                 Show this help
  -v, --version              Show version

Environment:
  BUFFER_API_KEY             Buffer personal API key (required for Buffer calls)
  MCP_HTTP_TOKEN             Bearer token for the HTTP transport
  CLOUDINARY_URL             cloudinary://<key>:<secret>@<cloud>
  CLOUDINARY_CLOUD_NAME      Cloudinary cloud name
  CLOUDINARY_API_KEY         Cloudinary API key
  CLOUDINARY_API_SECRET      Cloudinary API secret
`;

function buildContext(
  config: ResolvedConfig,
  configPath: string,
  transport: "stdio" | "http",
): ToolContext {
  const logger = new Logger(config.logging.level, config.logging.redact);
  const client = new BufferClient(config, logger, process.env);
  const provider = createProvider(config, logger, process.env);
  return {
    config,
    configPath,
    env: process.env,
    logger,
    client,
    provider,
    transport,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(HELP);
    return;
  }
  if (args.version) {
    process.stderr.write("buffer-mcp 1.0.0\n");
    return;
  }

  const loaded = loadConfig({
    configPath: args.config,
    cli: {
      transportMode: args.transportMode,
      host: args.host,
      port: args.port,
      dryRun: args.dryRun,
      allowDestructive: args.allowDestructive,
    },
  });

  const config = loaded.config;
  const bootLogger = new Logger(config.logging.level, config.logging.redact);
  bootLogger.info("buffer-mcp starting", {
    transport: config.transport.mode,
    configPath: loaded.configPath || null,
    configFileExists: loaded.fileExists,
    bufferKeyConfigured: Boolean(
      config.buffer.apiKey || process.env[config.buffer.apiKeyEnv],
    ),
    cloudinaryConfigured: Boolean(
      config.cloudinary.cloudName &&
        config.cloudinary.apiKey &&
        config.cloudinary.apiSecret,
    ),
    dryRun: config.safety.dryRun,
    allowDestructive: config.safety.allowDestructive,
  });

  if (!config.buffer.apiKey && !process.env[config.buffer.apiKeyEnv]) {
    bootLogger.warn("Buffer API key is not set; Buffer tools will fail until it is configured.", {
      envVar: config.buffer.apiKeyEnv,
    });
  }

  const mode = config.transport.mode;
  const cleanups: Array<() => Promise<void>> = [];

  if (mode === "stdio" || mode === "both") {
    const ctx = buildContext(config, loaded.configPath, "stdio");
    const server = createServer(ctx);
    await startStdio(server, ctx.logger);
  }

  if (mode === "http" || mode === "both") {
    const ctx = buildContext(config, loaded.configPath, "http");
    const http = await startHttpTransport({
      config,
      http: config.transport.http,
      logger: ctx.logger,
      env: process.env,
      createServer: () => createServer(ctx),
    });
    cleanups.push(http.close);
  }

  const shutdown = async (signal: string) => {
    bootLogger.info("Shutting down", { signal });
    for (const cleanup of cleanups) {
      await cleanup().catch(() => undefined);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      msg: "Unhandled rejection",
      reason: reason instanceof Error ? reason.message : String(reason),
    })}\n`,
  );
});

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof ConfigError ? err.hint : undefined;
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      msg: message,
      ...(hint ? { hint } : {}),
    })}\n`,
  );
  process.exit(1);
});
