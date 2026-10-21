import type { ResolvedConfig } from "../config/schema.js";
import type { Logger } from "../core/logger.js";
import { CloudinaryProvider } from "./cloudinary.js";
import type { MediaProvider } from "./types.js";

export function createProvider(
  config: ResolvedConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): MediaProvider | null {
  if (!config.cloudinary.enabled) return null;
  switch (config.cloudinary.provider) {
    case "cloudinary":
      return new CloudinaryProvider(config, logger, env);
    default:
      return null;
  }
}

export type { MediaProvider } from "./types.js";
