/**
 * Named ConfigSelector Registry
 *
 * One ConfigSelector per subsystem. This is the single source of truth
 * for "which config slice does each subsystem depend on?"
 *
 * Selectors are used by operations and NaxRuntime to declare config dependencies
 * without duplicating projection logic or creating orphan hardcoded key lists.
 */

import { pickSelector, reshapeSelector } from "./selector";
import type { NaxConfig } from "./types";

export const reviewConfigSelector = pickSelector("review", "review", "debate");
export const planConfigSelector = pickSelector("plan", "plan", "debate");
export const decomposeConfigSelector = pickSelector("decompose", "plan", "agent");
export const rectifyConfigSelector = pickSelector("rectify", "execution");
export const acceptanceConfigSelector = pickSelector("acceptance", "acceptance");
export const acceptanceFixConfigSelector = pickSelector("acceptance-fix", "acceptance", "execution");
export const tddConfigSelector = pickSelector("tdd", "tdd", "execution");
export const debateConfigSelector = pickSelector("debate", "debate");
export const routingConfigSelector = pickSelector("routing", "routing");

export const verifyConfigSelector = reshapeSelector("verify", (c: NaxConfig) => ({
  timeout: c.execution?.verificationTimeoutSeconds,
  testCommand: c.quality?.commands?.test,
}));

export const rectificationGateConfigSelector = pickSelector(
  "rectification-gate",
  "execution",
  "models",
  "agent",
  "quality",
  "review",
);
