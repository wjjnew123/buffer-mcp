import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CHANNEL } from "../core/documents.js";
import { ok, fail, type ToolContext } from "./context.js";
import {
  fetchChannels,
  resolveOrganizationId,
  type AccountResponse,
  type ChannelRecord,
} from "./shared.js";
import { ORGANIZATIONS } from "../core/documents.js";

export function registerChannelTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "buffer_list_organizations",
    {
      title: "List Buffer organizations",
      description:
        "List the organizations available to the configured Buffer API key, including plan limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const data = await ctx.client.graphql<AccountResponse>(ORGANIZATIONS);
        return ok({
          account: {
            id: data.account.id,
            email: data.account.email,
            name: data.account.name,
            timezone: data.account.timezone,
          },
          organizations: data.account.organizations,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_list_channels",
    {
      title: "List channels",
      description:
        "List connected channels for an organization with service, timezone, and queue state.",
      inputSchema: {
        organizationId: z
          .string()
          .optional()
          .describe("Organization id. Defaults to buffer.organizationId or the first organization."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ organizationId }) => {
      try {
        const orgId = await resolveOrganizationId(ctx, organizationId);
        const channels = await fetchChannels(ctx, orgId);
        return ok({
          organizationId: orgId,
          count: channels.length,
          channels: channels.map((c) => ({
            id: c.id,
            name: c.name,
            displayName: c.displayName,
            service: c.service,
            type: c.type,
            organizationId: c.organizationId,
            timezone: c.timezone,
            isDisconnected: c.isDisconnected,
            isLocked: c.isLocked,
            isQueuePaused: c.isQueuePaused,
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_get_channel",
    {
      title: "Get channel",
      description: "Fetch a single channel by id.",
      inputSchema: {
        channelId: z.string().describe("Buffer channel id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ channelId }) => {
      try {
        const data = await ctx.client.graphql<{ channel: ChannelRecord }>(CHANNEL, {
          input: { id: channelId },
        });
        return ok(data.channel);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
