/**
 * Tests for majorityFailClosedSelector and majorityFailOpenSelector — US-002 AC2
 */

import { describe, expect, test } from "bun:test";
import { majorityFailClosedSelector, majorityFailOpenSelector } from "@/debate";
import type { SelectorContext } from "@/debate/selectors/types";
import type { SuccessfulProposal } from "@/debate/session-helpers";
import { makeMockAgentManager, makeMockCallContext } from "@test/helpers";

function makeProposals(outputs: string[]): SuccessfulProposal[] {
  return outputs.map((output) => ({
    debater: { agent: "claude" },
    agentName: "claude",
    output,
    cost: 0,
  }));
}

const DEFAULT_SELECTOR_CONFIG: SelectorContext["config"] = {
  debate: {
    enabled: true,
    grounder: { model: "fast", timeoutSeconds: 60 },
    agents: 2,
    maxConcurrentDebaters: 2,
    stages: {
      plan: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
      review: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
      acceptance: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
      rectification: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
      escalation: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
    },
  },
  agent: { default: "claude" },
};

function makeCtx(overrides: Partial<SelectorContext> = {}): SelectorContext {
  return {
    storyId: "US-001",
    stage: "plan",
    stageConfig: {
      enabled: true,
      resolver: { type: "majority-fail-closed" },
      sessionMode: "one-shot",
      rounds: 1,
    },
    config: DEFAULT_SELECTOR_CONFIG,
    proposals: makeProposals([]),
    critiques: [],
    workdir: "/tmp/test",
    featureName: "test",
    timeoutMs: 30000,
    agentManager: makeMockAgentManager(),
    debaters: [],
    callContext: makeMockCallContext(),
    ...overrides,
  };
}

describe("majorityFailClosedSelector", () => {
  test("returns outcome 'passed' when strict majority pass", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(['{"passed": true}', '{"passed": true}', '{"passed": false}']),
    });
    const result = await majorityFailClosedSelector(ctx);
    expect(result.outcome).toBe("passed");
  });

  test("returns outcome 'failed' on tie (fail-closed)", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(['{"passed": true}', '{"passed": false}']),
    });
    const result = await majorityFailClosedSelector(ctx);
    expect(result.outcome).toBe("failed");
  });

  test("does not include resolverCostUsd in result", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(['{"passed": true}', '{"passed": true}']),
    });
    const result = await majorityFailClosedSelector(ctx);
    expect("resolverCostUsd" in result).toBe(false);
  });

  test("maps outcome from majorityResolver(proposalOutputs, false)", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(["not json", "not json", "not json"]),
    });
    const result = await majorityFailClosedSelector(ctx);
    expect(result.outcome).toBe("failed"); // fail-closed: unparseable → fail
  });
});

describe("majorityFailOpenSelector", () => {
  test("returns outcome 'passed' on tie (fail-open)", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(['{"passed": true}', '{"passed": false}']),
    });
    const result = await majorityFailOpenSelector(ctx);
    expect(result.outcome).toBe("passed");
  });

  test("returns outcome 'passed' for all unparseable (fail-open)", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(["not json", "also not json", "still not json"]),
    });
    const result = await majorityFailOpenSelector(ctx);
    expect(result.outcome).toBe("passed"); // fail-open: unparseable → pass
  });

  test("does not include resolverCostUsd in result", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(['{"passed": false}', '{"passed": false}']),
    });
    const result = await majorityFailOpenSelector(ctx);
    expect("resolverCostUsd" in result).toBe(false);
  });

  test("maps outcome from majorityResolver(proposalOutputs, true) — explicit false still counts as pass in fail-open", async () => {
    const ctx = makeCtx({
      proposals: makeProposals(['{"passed": false}', '{"passed": false}', '{"passed": false}']),
    });
    const result = await majorityFailOpenSelector(ctx);
    // In fail-open mode, non-true values (including explicit false) go to passCount, so result is "passed"
    expect(result.outcome).toBe("passed");
  });
});
