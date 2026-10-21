import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerConfigTools } from "./config.tools.js";
import { registerChannelTools } from "./channel.tools.js";
import { registerPostTools } from "./post.tools.js";
import { registerMediaTools } from "./media.tools.js";
import { registerAnalyticsTools } from "./analytics.tools.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerConfigTools(server, ctx);
  registerChannelTools(server, ctx);
  registerPostTools(server, ctx);
  registerMediaTools(server, ctx);
  registerAnalyticsTools(server, ctx);
}
