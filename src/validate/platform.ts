import type { ResolvedConfig } from "../config/schema.js";
import { checkText } from "./text.js";

export type AssetKind = "image" | "video" | "document";

export interface AssetInfo {
  kind: AssetKind;
  url: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface ValidationIssue {
  severity: "block" | "warn";
  code: string;
  message: string;
  hint?: string;
}

export interface ValidateInput {
  service: string;
  text: string;
  assets: AssetInfo[];
  metadata: Record<string, unknown>;
  config: ResolvedConfig;
}

const TYPE_REQUIRED = new Set(["facebook", "instagram"]);
const ASSET_REQUIRED = new Set(["instagram", "youtube", "tiktok", "pinterest"]);

export function validatePost(input: ValidateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { service, text, assets, metadata, config } = input;
  const warnOnly = config.validation.warnOnly;
  const block = (code: string, message: string, hint?: string): void => {
    issues.push({ severity: warnOnly ? "warn" : "block", code, message, hint });
  };

  if (config.validation.enforceTextLimits) {
    const check = checkText(text, service);
    if (!check.ok) {
      block(
        "TEXT_TOO_LONG",
        `Text is ${check.used} characters but ${service} allows ${check.limit}.`,
        check.option === "instagram"
          ? "Instagram counts each line break as two characters."
          : undefined,
      );
    }
  }

  if (TYPE_REQUIRED.has(service)) {
    const type = metadata.type;
    if (typeof type !== "string" || !type) {
      block(
        "MISSING_TYPE",
        `${service} posts require metadata.type.`,
        "Use type 'post' for feed posts, 'story' for stories, 'reel' for reels.",
      );
    }
  }

  if (service === "instagram" && typeof metadata.shouldShareToFeed !== "boolean") {
    block(
      "MISSING_SHOULD_SHARE_TO_FEED",
      "Instagram metadata requires shouldShareToFeed (boolean).",
      "Use true for feed posts.",
    );
  }

  if (ASSET_REQUIRED.has(service) && assets.length === 0) {
    block("MISSING_ASSETS", `${service} requires at least one media asset.`);
  }

  if (service === "youtube") {
    if (typeof metadata.categoryId !== "string" || !metadata.categoryId) {
      block(
        "MISSING_YOUTUBE_CATEGORY",
        "YouTube posts require metadata.categoryId.",
        "For example '2' (Autos & Vehicles) or '28' (Science & Technology).",
      );
    }
    if (assets.some((a) => a.kind !== "video")) {
      block("YOUTUBE_REQUIRES_VIDEO", "YouTube only accepts video assets.");
    }
    if (config.validation.rejectYoutubeHorizontalShort) {
      for (const asset of assets) {
        if (asset.kind !== "video") continue;
        const duration = asset.durationMs;
        if (duration !== undefined && duration <= 60_000 && asset.width && asset.height) {
          if (asset.width > asset.height) {
            block(
              "YOUTUBE_HORIZONTAL_SHORT",
              `Video is ${Math.round(duration / 1000)}s and horizontal (${asset.width}x${asset.height}). Buffer treats videos of 60s or less as YouTube Shorts, which require a portrait frame.`,
              "Export a 1080x1920 vertical version, pad it with c_pad,w_1080,h_1920, or make the video longer than 60 seconds.",
            );
          }
        }
      }
    }
  }

  if (assets.some((a) => a.kind === "document")) {
    issues.push({
      severity: "warn",
      code: "DOCUMENT_ASSET",
      message: "Document assets need both url and thumbnailUrl plus a title; verify the payload before sending.",
    });
  }

  return issues;
}

export function hasBlockingIssues(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "block");
}
