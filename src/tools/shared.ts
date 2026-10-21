import type { ToolContext } from "./context.js";
import { AppError } from "../core/errors.js";
import { CHANNELS, ORGANIZATIONS } from "../core/documents.js";

export interface ChannelRecord {
  id: string;
  name: string;
  displayName?: string | null;
  service: string;
  type: string;
  descriptor: string;
  organizationId: string;
  timezone: string;
  avatar: string;
  serviceId: string;
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
  hasActiveMemberDevice: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountResponse {
  account: {
    id: string;
    email: string;
    name?: string | null;
    timezone?: string | null;
    organizations: Array<{
      id: string;
      name: string;
      channelCount: number;
      limits: { channels: number; scheduledPosts: number };
    }>;
  };
}

export async function resolveOrganizationId(
  ctx: ToolContext,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  if (ctx.config.buffer.organizationId) return ctx.config.buffer.organizationId;
  const data = await ctx.client.graphql<AccountResponse>(ORGANIZATIONS);
  const first = data.account?.organizations?.[0];
  if (!first) {
    throw new AppError(
      "No Buffer organization is available for this API key.",
      "NO_ORGANIZATION",
      "Make sure the API key belongs to an organization with at least one channel.",
    );
  }
  return first.id;
}

export async function fetchChannels(
  ctx: ToolContext,
  organizationId: string,
): Promise<ChannelRecord[]> {
  const data = await ctx.client.graphql<{ channels: ChannelRecord[] }>(CHANNELS, {
    input: { organizationId },
  });
  return data.channels ?? [];
}

export function channelIdsOf(channels: ChannelRecord[]): Set<string> {
  return new Set(channels.map((c) => c.id));
}
