import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";
import type { ToolContext } from "./tools/context.js";

export const SERVER_NAME = "buffer-mcp";
export const SERVER_VERSION = "1.0.0";
export const SERVER_INSTRUCTIONS = [
  "Buffer publishing server with built-in Cloudinary media upload.",
  "Read tools are always available. Write tools require confirm tokens",
  "(buffer_create_post -> \"create\", cloudinary_upload -> \"upload\",",
  "buffer_delete_post -> the post id). Destructive tools additionally require",
  "safety.allowDestructive=true. Over HTTP, writes additionally require",
  "transport.http.allowWrites=true.",
  "Always show the payload to the user before calling a write tool.",
].join(" ");

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "Buffer publishing MCP",
    },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerAllTools(server, ctx);
  return server;
}
