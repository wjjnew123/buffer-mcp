import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HttpConfig, ResolvedConfig } from "../config/schema.js";
import { isLoopbackHost, resolveHttpToken } from "../config/load.js";
import type { Logger } from "../core/logger.js";
import { RateLimiter, extractBearer, ipAllowed, tokenMatches } from "./auth.js";

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface HttpTransportOptions {
  config: ResolvedConfig;
  http: HttpConfig;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  createServer: () => McpServer;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new Error(`Request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (raw) return raw.split(",")[0].trim();
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

function corsHeaders(origin: string | undefined, allowed: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
    "Access-Control-Max-Age": "600",
  };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers["Access-Control-Allow-Origin"] = allowed.includes("*") ? "*" : origin;
    headers.Vary = "Origin";
  }
  return headers;
}

export async function startHttpTransport(
  options: HttpTransportOptions,
): Promise<{ server: Server; close: () => Promise<void> }> {
  const { config, http, logger } = options;
  const token = resolveHttpToken(config, options.env);
  const localOnly = isLoopbackHost(http.host);

  if (!localOnly && !token) {
    throw new Error(
      `Refusing to expose the HTTP transport on ${http.host} without MCP_HTTP_TOKEN.`,
    );
  }

  const sessions = new Map<string, SessionEntry>();
  const limiter = http.rateLimit.enabled
    ? new RateLimiter(http.rateLimit.windowMs, http.rateLimit.max)
    : null;

  const createSession = (): SessionEntry => {
    const server = options.createServer();
    const entry = {
      server,
      transport: undefined as unknown as StreamableHTTPServerTransport,
      lastSeen: Date.now(),
    } satisfies SessionEntry;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, entry);
        logger.debug("MCP HTTP session opened", { sessionId });
      },
    });

    entry.transport = transport;
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
    };
    transport.onerror = (error) => {
      logger.warn("MCP HTTP transport error", { error: error.message });
    };

    void server.connect(transport).catch((err) => {
      logger.error("Failed to connect MCP server to HTTP transport", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return entry;
  };

  const httpServer = createHttpServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error("Unhandled HTTP error", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const origin = Array.isArray(req.headers.origin)
      ? req.headers.origin[0]
      : req.headers.origin;
    const cors = corsHeaders(origin, http.corsOrigins);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok", sessions: sessions.size }, cors);
      return;
    }

    if (url.pathname !== http.path) {
      sendJson(res, 404, { error: "Not found" }, cors);
      return;
    }

    if (token) {
      const provided = extractBearer(req.headers.authorization);
      if (!provided || !tokenMatches(token, provided)) {
        sendJson(
          res,
          401,
          { error: "Unauthorized" },
          { ...cors, "WWW-Authenticate": 'Bearer realm="buffer-mcp"' },
        );
        return;
      }
    } else if (!localOnly) {
      sendJson(res, 403, { error: "Forbidden" }, cors);
      return;
    }

    const ip = clientIp(req, http.trustProxy);
    if (!ipAllowed(ip, http.allowedIps)) {
      sendJson(res, 403, { error: "IP not allowed" }, cors);
      return;
    }

    if (limiter) {
      const verdict = limiter.check(ip);
      if (!verdict.allowed) {
        sendJson(
          res,
          429,
          { error: "Too many requests" },
          { ...cors, "Retry-After": Math.ceil(verdict.retryAfterMs / 1000).toString() },
        );
        return;
      }
    }

    if (http.stateless && req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed in stateless mode" }, cors);
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req, http.maxBodyBytes);
      } catch (err) {
        sendJson(
          res,
          400,
          { error: err instanceof Error ? err.message : "Invalid body" },
          cors,
        );
        return;
      }

      if (http.stateless) {
        // 无会话模式：每个请求用全新 server/transport，忽略客户端带来的
        // Mcp-Session-Id。服务端重启/会话过期不会导致 404 Session not found。
        const statelessServer = options.createServer();
        const statelessTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await statelessServer.connect(statelessTransport);
        res.on("close", () => {
          void statelessTransport.close().catch(() => undefined);
          void statelessServer.close().catch(() => undefined);
        });
        await statelessTransport.handleRequest(req, res, body);
        return;
      }

      let entry = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !entry) {
        sendJson(res, 404, { error: "Session not found" }, cors);
        return;
      }
      if (!entry) {
        if (!isInitializeRequest(body)) {
          sendJson(
            res,
            400,
            { error: "Bad Request: missing or invalid Mcp-Session-Id for a non-initialize request" },
            cors,
          );
          return;
        }
        entry = createSession();
      }

      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET") {
      if (!sessionId) {
        sendJson(res, 400, { error: "Mcp-Session-Id header is required" }, cors);
        return;
      }
      const entry = sessions.get(sessionId);
      if (!entry) {
        sendJson(res, 404, { error: "Session not found" }, cors);
        return;
      }
      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      if (!sessionId) {
        sendJson(res, 400, { error: "Mcp-Session-Id header is required" }, cors);
        return;
      }
      const entry = sessions.get(sessionId);
      if (!entry) {
        sendJson(res, 404, { error: "Session not found" }, cors);
        return;
      }
      await entry.transport.close();
      sessions.delete(sessionId);
      sendJson(res, 200, { ok: true }, cors);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" }, cors);
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    limiter?.sweep(now);
    for (const [sessionId, entry] of sessions) {
      if (now - entry.lastSeen > http.sessionTtlMs) {
        void entry.transport.close().catch(() => undefined);
        sessions.delete(sessionId);
        logger.debug("MCP HTTP session expired", { sessionId });
      }
    }
  }, 60_000);
  sweeper.unref?.();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(http.port, http.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  logger.info("MCP HTTP transport listening", {
    url: `http://${http.host}:${http.port}${http.path}`,
    auth: token ? "bearer" : "none(loopback)",
    allowWrites: http.allowWrites,
    corsOrigins: http.corsOrigins,
  });

  return {
    server: httpServer,
    close: async () => {
      clearInterval(sweeper);
      for (const [sessionId, entry] of sessions) {
        await entry.transport.close().catch(() => undefined);
        sessions.delete(sessionId);
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
