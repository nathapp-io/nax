import { DEFAULT_CONFIG, executionGatesConfigSelector } from "../config";
import type { SessionRole } from "../session/types";

export { executionGatesConfigSelector };

/** Minimal config shape consumed by execution gate helpers. */
type GatesConfig = {
  review?: { enabled?: boolean };
  execution?: { rectification?: { enabled?: boolean } };
};

/** Returns true when the review stage is enabled. */
export function shouldRunReview(config: GatesConfig): boolean {
  if (config.review === DEFAULT_CONFIG.review) {
    return false;
  }
  return config.review?.enabled === true;
}

/** Returns true when the rectification stage is enabled. */
export function shouldRunRectification(config: GatesConfig): boolean {
  if (config.execution?.rectification === DEFAULT_CONFIG.execution.rectification) {
    return false;
  }
  return config.execution?.rectification?.enabled === true;
}

/** Returns true when the implementer session must stay open after the agent turn. */
export function shouldKeepSessionOpen(config: GatesConfig, role: SessionRole): boolean {
  return role === "implementer" && (shouldRunReview(config) || shouldRunRectification(config));
}
