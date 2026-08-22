/**
 * `EscalationHandlerContext` fixtures.
 *
 * 16 casts across three tier-escalation test files, every one spelled
 * `Parameters<typeof handleTierEscalation>[0]` — which is just
 * `EscalationHandlerContext`, exported from `@/execution/escalation` all along.
 * The indirection was the only reason this looked like a type with no name
 * (#1514 phase 1b).
 *
 * Defaults are a single in-progress story on the fast tier with an empty
 * pipeline result. No cast: the compiler checks whatever the test overrides.
 */
import type { EscalationHandlerContext } from "@/execution/escalation";
import { makeMockAgentManager } from "./mock-agent-manager";
import { makeNaxConfig } from "./mock-nax-config";
import { makePRD, makeStory } from "./mock-story";

export function makeEscalationContext(overrides: Partial<EscalationHandlerContext> = {}): EscalationHandlerContext {
  const story = overrides.story ?? makeStory({ status: "in-progress", attempts: 1 });
  return {
    story,
    storiesToExecute: [story],
    isBatchExecution: false,
    routing: { modelTier: "fast", testStrategy: "test-after" },
    pipelineResult: { context: {} },
    config: makeNaxConfig(),
    prd: makePRD({ userStories: [story] }),
    prdPath: "/tmp/test-prd.json",
    hooks: { hooks: {} },
    feature: "test-feature",
    totalCost: 0,
    workdir: "/tmp",
    agentManager: makeMockAgentManager(),
    ...overrides,
  };
}
