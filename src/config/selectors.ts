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

export const reviewConfigSelector = pickSelector("review", "review", "debate", "models", "execution");
export const planConfigSelector = pickSelector("plan", "plan", "debate");
export const decomposeConfigSelector = pickSelector("decompose", "plan", "agent");
export const rectifyConfigSelector = pickSelector("rectify", "execution");
export const acceptanceConfigSelector = pickSelector("acceptance", "acceptance");
// acceptance fix take more time to fix the code, so we use a separate config selector to use execution.sessionTimeoutSeconds instead of acceptance.timeoutMs
export const acceptanceFixConfigSelector = pickSelector("acceptance-fix", "acceptance", "execution");
// acceptance generator take more time to generate the test code, so we use a separate config selector to use execution.sessionTimeoutSeconds instead of acceptance.timeoutMs
export const acceptanceGenConfigSelector = pickSelector("acceptance-gen", "acceptance", "execution");
export const tddConfigSelector = pickSelector("tdd", "tdd", "execution", "quality", "agent", "models");
export const debateConfigSelector = pickSelector("debate", "debate", "models");
export const routingConfigSelector = pickSelector("routing", "routing", "autoMode", "tdd");

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

export const agentManagerConfigSelector = pickSelector("agent-manager", "agent", "execution");
export const interactionConfigSelector = pickSelector("interaction", "interaction");
export const precheckConfigSelector = pickSelector(
  "precheck",
  "precheck",
  "quality",
  "execution",
  "prompts",
  "review",
  "project",
);
export const qualityConfigSelector = pickSelector("quality", "quality", "execution");
