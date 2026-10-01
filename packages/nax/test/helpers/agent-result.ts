/**
 * `AgentResult` fixtures.
 *
 * Six required fields, of which most tests only care about one — usually
 * `estimatedCostUsd` or `output`. Sites wrote the one and cast the rest away.
 * Complete defaults here mean no cast, and the compiler still checks whichever
 * field the test is actually asserting on (#1514 phase 1b).
 */
import type { AgentResult } from "@/agents/types";

export function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: "",
    rateLimited: false,
    durationMs: 0,
    estimatedCostUsd: 0,
    ...overrides,
  };
}
