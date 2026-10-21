import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../core/errors.js";
import {
  AGGREGATED_METRICS,
  CREATE_IDEA,
  DAILY_LIMITS,
  IDEAS,
  IDEA_GROUPS,
} from "../core/documents.js";
import { fail, guardWrite, ok, type ToolContext } from "./context.js";
import { resolveOrganizationId } from "./shared.js";

const FREE_PLAN_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

interface DailyLimitRow {
  channelId: string;
  isAtLimit: boolean;
  limit?: number | null;
  scheduled: number;
  sent: number;
}

interface IdeaRow {
  id: string;
  groupId?: string | null;
  organizationId: string;
  position?: number | null;
  createdAt: number;
  updatedAt: number;
  content: {
    title?: string | null;
    text?: string | null;
    date?: string | null;
    services?: string[];
    aiAssisted: boolean;
  };
}

export function registerAnalyticsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "buffer_list_daily_limits",
    {
      title: "Check daily posting limits",
      description:
        "Return each channel's daily posting limit, how many posts are scheduled and sent, and whether the limit is reached.",
      inputSchema: {
        channelIds: z.array(z.string()).min(1),
        date: z
          .string()
          .optional()
          .describe("ISO 8601 date. Defaults to now."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ channelIds, date }) => {
      try {
        const data = await ctx.client.graphql<{ dailyPostingLimits: DailyLimitRow[] }>(
          DAILY_LIMITS,
          { input: { channelIds, date: date ?? new Date().toISOString() } },
        );
        return ok({ date: date ?? new Date().toISOString(), limits: data.dailyPostingLimits });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_get_analytics",
    {
      title: "Get aggregated post metrics",
      description:
        "Return aggregated metrics for an organization in a date range. On the free plan the window is capped at 31 days, so longer ranges are clamped and reported.",
      inputSchema: {
        organizationId: z.string().optional(),
        channelIds: z.array(z.string()).optional(),
        startDateTime: z.string().describe("ISO 8601 start."),
        endDateTime: z.string().describe("ISO 8601 end."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ organizationId, channelIds, startDateTime, endDateTime }) => {
      try {
        const start = new Date(startDateTime);
        const end = new Date(endDateTime);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          throw new AppError("startDateTime and endDateTime must be ISO 8601.", "INVALID_DATE");
        }
        if (end <= start) {
          throw new AppError("endDateTime must be after startDateTime.", "INVALID_RANGE");
        }
        let effectiveEnd = end;
        let clamped = false;
        if (end.getTime() - start.getTime() > FREE_PLAN_WINDOW_MS) {
          effectiveEnd = new Date(start.getTime() + FREE_PLAN_WINDOW_MS);
          clamped = true;
        }

        const orgId = await resolveOrganizationId(ctx, organizationId);
        const data = await ctx.client.graphql<{
          aggregatedPostMetrics: {
            metricsUpdatedAt?: string | null;
            metrics: Array<{
              name: string;
              description: string;
              type: string;
              unit: string;
              value: number;
            }>;
          };
        }>(AGGREGATED_METRICS, {
          input: {
            organizationId: orgId,
            ...(channelIds?.length ? { channelIds } : {}),
            startDateTime: start.toISOString(),
            endDateTime: effectiveEnd.toISOString(),
          },
        });
        return ok({
          organizationId: orgId,
          requestedRange: { start: start.toISOString(), end: end.toISOString() },
          effectiveRange: {
            start: start.toISOString(),
            end: effectiveEnd.toISOString(),
          },
          clamped,
          ...(clamped
            ? {
                note: "The free plan only exposes the last 31 days of metrics; the range was clamped.",
              }
            : {}),
          ...data.aggregatedPostMetrics,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_list_ideas",
    {
      title: "List ideas",
      description: "List ideas in the organization's idea board.",
      inputSchema: {
        organizationId: z.string().optional(),
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ organizationId, first, after }) => {
      try {
        const orgId = await resolveOrganizationId(ctx, organizationId);
        const data = await ctx.client.graphql<{
          ideas: {
            edges: Array<{ cursor: string; node: IdeaRow }>;
            pageInfo: { hasNextPage: boolean; endCursor?: string | null };
          };
        }>(IDEAS, {
          input: { organizationId: orgId },
          first: first ?? 20,
          after: after ?? null,
        });
        return ok({
          organizationId: orgId,
          count: data.ideas.edges.length,
          ideas: data.ideas.edges.map((e) => e.node),
          pageInfo: data.ideas.pageInfo,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_list_idea_groups",
    {
      title: "List idea groups",
      description: "List the idea groups (boards) in an organization.",
      inputSchema: {
        organizationId: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ organizationId }) => {
      try {
        const orgId = await resolveOrganizationId(ctx, organizationId);
        const data = await ctx.client.graphql<{
          ideaGroups: Array<{ id: string; name: string; isLocked: boolean }>;
        }>(IDEA_GROUPS, { input: { organizationId: orgId } });
        return ok({ organizationId: orgId, groups: data.ideaGroups });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "buffer_create_idea",
    {
      title: "Create an idea",
      description:
        "Create an idea on the idea board. Requires confirm=\"idea\".",
      inputSchema: {
        organizationId: z.string().optional(),
        title: z.string().optional(),
        text: z.string().optional(),
        services: z.array(z.string()).optional(),
        confirm: z.string().optional().describe('Must be "idea".'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ organizationId, title, text, services, confirm }) => {
      try {
        if (!title && !text) {
          throw new AppError("Provide title and/or text.", "INVALID_INPUT");
        }
        guardWrite(ctx, {
          action: "buffer_create_idea",
          expected: "idea",
          confirm,
          payload: { title, text, services },
        });
        const orgId = await resolveOrganizationId(ctx, organizationId);
        const data = await ctx.client.graphql<{
          createIdea: {
            __typename: string;
            id?: string;
            message?: string;
            content?: { title?: string | null; text?: string | null };
          };
        }>(CREATE_IDEA, {
          input: {
            organizationId: orgId,
            content: {
              ...(title ? { title } : {}),
              ...(text ? { text } : {}),
              ...(services?.length ? { services } : {}),
            },
          },
        });
        const payload = data.createIdea;
        return ok({
          success: payload.__typename === "Idea",
          ideaId: payload.id,
          error: payload.__typename === "Idea" ? undefined : payload.message ?? payload.__typename,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
