/**
 * Tests for debate resolvers — US-002
 *
 * Covers:
 * - AC7: majorityResolver returns 'passed' when 2 of 3 proposals contain "passed": true
 * - AC8: majorityResolver returns fail-closed 'failed' on tie (1 pass, 1 fail, 1 unparseable)
 * - AC9: synthesisResolver calls adapter.complete() once with synthesis prompt + returns output
 * - AC10: judgeResolver calls adapter.complete() with judge prompt using resolver.agent
 *         (or default agent at fast tier if resolver.agent is unset)
 */

import { describe, expect, mock, test } from "bun:test";
import {
  judgeResolver,
  majorityResolver,
  synthesisResolver,
} from "../../../src/debate/resolvers";
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../../../src/agents/types";
import type { ResolverConfig } from "../../../src/debate/types";

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function makeMockAdapter(
  name: string,
  completeFn?: (prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>,
): AgentAdapter {
  return {
    name,
    displayName: name,
    binary: name,
    capabilities: {
      supportedTiers: ["fast"] as const,
      maxContextTokens: 100_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(["review"]),
    },
    isInstalled: async () => true,
    run: async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
    }),
    buildCommand: () => [],
    plan: async () => ({ specContent: "" }),
    decompose: async () => ({ stories: [] }),
    complete: completeFn ?? (async () => ({ output: "default output", costUsd: 0, source: "fallback" })),
  };
}

// ─── AC7 & AC8: majorityResolver ─────────────────────────────────────────────

describe("majorityResolver()", () => {
  test("returns 'passed' when 2 of 3 proposals contain \"passed\": true", () => {
    const proposals = [
      '{"passed": true, "reason": "looks good"}',
      '{"passed": true, "reason": "acceptable"}',
      '{"passed": false, "reason": "needs work"}',
    ];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("passed");
  });

  test("returns 'failed' when 2 of 3 proposals contain \"passed\": false", () => {
    const proposals = [
      '{"passed": false, "reason": "not ready"}',
      '{"passed": false, "reason": "missing tests"}',
      '{"passed": true, "reason": "looks good"}',
    ];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("failed");
  });

  test("returns 'passed' when all 3 proposals pass", () => {
    const proposals = [
      '{"passed": true}',
      '{"passed": true}',
      '{"passed": true}',
    ];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("passed");
  });

  test("returns 'failed' when all 3 proposals fail", () => {
    const proposals = [
      '{"passed": false}',
      '{"passed": false}',
      '{"passed": false}',
    ];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("failed");
  });

  // AC8: fail-closed on tie
  test("returns fail-closed 'failed' on tie: 1 pass, 1 fail, 1 unparseable", () => {
    const proposals = [
      '{"passed": true, "reason": "looks good"}',
      '{"passed": false, "reason": "needs work"}',
      "this is not valid JSON",
    ];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("failed");
  });

  test("returns fail-closed 'failed' on exact 50/50 tie with 2 debaters", () => {
    const proposals = [
      '{"passed": true}',
      '{"passed": false}',
    ];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("failed");
  });

  test("returns fail-closed 'failed' when all proposals are unparseable", () => {
    const proposals = ["not json", "also not json", "still not json"];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("failed");
  });

  test("handles proposals with markdown fence wrapping around JSON", () => {
    const proposals = [
      "```json\n{\"passed\": true}\n```",
      '{"passed": true}',
      '{"passed": false}',
    ];

    // 2 pass — should return 'passed'
    const result = majorityResolver(proposals, false);

    expect(result).toBe("passed");
  });

  test("returns 'failed' when only 1 of 3 proposals passes", () => {
    const proposals = [
      '{"passed": true}',
      '{"passed": false}',
      '{"passed": false}',
    ];

    const result = majorityResolver(proposals, false);

    expect(result).toBe("failed");
  });
});

// ─── majorityResolver fail-open ─────────────────────────────────────────────

describe("majorityResolver(..., true) — fail-open", () => {
  test("returns fail-open 'passed' on tie: 1 pass, 1 fail, 1 unparseable", () => {
    const proposals = [
      '{"passed": true, "reason": "looks good"}',
      '{"passed": false, "reason": "needs work"}',
      "this is not valid JSON",
    ];

    const result = majorityResolver(proposals, true);

    expect(result).toBe("passed");
  });

  test("returns fail-open 'passed' when all proposals are unparseable", () => {
    const proposals = ["not json", "also not json", "still not json"];

    const result = majorityResolver(proposals, true);

    expect(result).toBe("passed"); // unparseable → pass in fail-open: passCount=3, failCount=0
  });

  test("returns fail-open 'passed' on exact 50/50 tie with 2 debaters", () => {
    const proposals = [
      '{"passed": true}',
      '{"passed": false}',
    ];

    const result = majorityResolver(proposals, true);

    expect(result).toBe("passed"); // tie goes to pass in fail-open
  });

  test("returns fail-open 'passed' when majority are parseable and pass", () => {
    const proposals = [
      '{"passed": true}',
      '{"passed": false}',
      "not json",
    ];

    const result = majorityResolver(proposals, true);

    expect(result).toBe("passed"); // 2 passCount (true + failOpen) vs 1 failCount
  });
});

// ─── AC9: synthesisResolver ──────────────────────────────────────────────────

describe("synthesisResolver()", () => {
  test("calls adapter.complete() exactly once", async () => {
    let callCount = 0;
    const adapter = makeMockAdapter("claude", async () => {
      callCount++;
      return { output: "synthesis output", costUsd: 0, source: "fallback" };
    });

    await synthesisResolver(["proposal 1", "proposal 2", "proposal 3"], [], { adapter });

    expect(callCount).toBe(1);
  });

  test("includes all proposals in the synthesis prompt", async () => {
    let capturedPrompt = "";
    const adapter = makeMockAdapter("claude", async (prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis output", costUsd: 0, source: "fallback" };
    });

    await synthesisResolver(
      ["proposal A content", "proposal B content", "proposal C content"],
      [],
      { adapter },
    );

    expect(capturedPrompt).toContain("proposal A content");
    expect(capturedPrompt).toContain("proposal B content");
    expect(capturedPrompt).toContain("proposal C content");
  });

  test("includes all critiques in the synthesis prompt", async () => {
    let capturedPrompt = "";
    const adapter = makeMockAdapter("claude", async (prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis output", costUsd: 0, source: "fallback" };
    });

    await synthesisResolver(["proposal 1"], ["critique X", "critique Y"], { adapter });

    expect(capturedPrompt).toContain("critique X");
    expect(capturedPrompt).toContain("critique Y");
  });

  test("returns output and cost metadata from adapter.complete()", async () => {
    const adapter = makeMockAdapter("claude", async () => ({ output: "the synthesis result", costUsd: 0, source: "fallback" }));

    const result = await synthesisResolver(["prop 1", "prop 2"], [], { adapter });

    expect(result.output).toBe("the synthesis result");
    expect(result.costUsd).toBe(0);
    expect(result.source).toBe("fallback");
  });

  test("works when critiques array is empty", async () => {
    const adapter = makeMockAdapter("claude", async () => ({ output: "synthesis without critiques", costUsd: 0, source: "fallback" }));

    const result = await synthesisResolver(["p1", "p2"], [], { adapter });

    expect(result.output).toBe("synthesis without critiques");
    expect(result.costUsd).toBe(0);
    expect(result.source).toBe("fallback");
  });

  test("preserves exact cost metadata from adapter.complete()", async () => {
    const adapter = makeMockAdapter("claude", async () => ({ output: "exact synthesis", costUsd: 0.42, source: "exact" }));

    const result = await synthesisResolver(["p1", "p2"], ["c1"], { adapter });

    expect(result.output).toBe("exact synthesis");
    expect(result.costUsd).toBeCloseTo(0.42, 6);
    expect(result.source).toBe("exact");
  });
});

// ─── AC10: judgeResolver ─────────────────────────────────────────────────────

describe("judgeResolver()", () => {
  test("uses resolver.agent to look up the judge adapter", async () => {
    let usedAgentName = "";

    const getAgentFn = mock((name: string) => {
      usedAgentName = name;
      return makeMockAdapter(name, async () => ({ output: "judge output", costUsd: 0, source: "fallback" }));
    });

    const resolverConfig: ResolverConfig = {
      type: "custom",
      agent: "judge-agent",
    };

    await judgeResolver(["proposal 1", "proposal 2"], ["critique 1"], resolverConfig, {
      getAgent: getAgentFn,
    });

    expect(usedAgentName).toBe("judge-agent");
  });

  test("calls adapter.complete() exactly once", async () => {
    let callCount = 0;

    const getAgentFn = mock((_name: string) =>
      makeMockAdapter("judge", async () => {
        callCount++;
        return { output: "judge output", costUsd: 0, source: "fallback" };
      }),
    );

    await judgeResolver(["p1", "p2"], ["c1"], { type: "custom", agent: "judge" }, {
      getAgent: getAgentFn,
    });

    expect(callCount).toBe(1);
  });

  test("includes all proposals in the judge prompt", async () => {
    let capturedPrompt = "";

    const getAgentFn = mock((_name: string) =>
      makeMockAdapter("judge", async (prompt) => {
        capturedPrompt = prompt;
        return { output: "judge output", costUsd: 0, source: "fallback" };
      }),
    );

    await judgeResolver(
      ["proposal alpha", "proposal beta"],
      ["critique one"],
      { type: "custom", agent: "judge" },
      { getAgent: getAgentFn },
    );

    expect(capturedPrompt).toContain("proposal alpha");
    expect(capturedPrompt).toContain("proposal beta");
  });

  test("includes critiques in the judge prompt", async () => {
    let capturedPrompt = "";

    const getAgentFn = mock((_name: string) =>
      makeMockAdapter("judge", async (prompt) => {
        capturedPrompt = prompt;
        return { output: "judge output", costUsd: 0, source: "fallback" };
      }),
    );

    await judgeResolver(
      ["p1"],
      ["critique one", "critique two"],
      { type: "custom", agent: "judge" },
      { getAgent: getAgentFn },
    );

    expect(capturedPrompt).toContain("critique one");
    expect(capturedPrompt).toContain("critique two");
  });

  test("returns output and cost metadata from adapter.complete()", async () => {
    const getAgentFn = mock((_name: string) =>
      makeMockAdapter("judge", async () => ({ output: "final judge verdict", costUsd: 0, source: "fallback" })),
    );

    const result = await judgeResolver(["p1"], [], { type: "custom", agent: "judge" }, {
      getAgent: getAgentFn,
    });

    expect(result.output).toBe("final judge verdict");
    expect(result.costUsd).toBe(0);
    expect(result.source).toBe("fallback");
  });

  test("preserves exact cost metadata from judge adapter complete()", async () => {
    const getAgentFn = mock((_name: string) =>
      makeMockAdapter("judge", async () => ({ output: "judge verdict", costUsd: 0.55, source: "exact" })),
    );

    const result = await judgeResolver(["p1"], ["c1"], { type: "custom", agent: "judge" }, {
      getAgent: getAgentFn,
    });

    expect(result.output).toBe("judge verdict");
    expect(result.costUsd).toBeCloseTo(0.55, 6);
    expect(result.source).toBe("exact");
  });

  test("uses defaultAgentName when resolver.agent is not specified", async () => {
    let usedAgentName = "";

    const getAgentFn = mock((name: string) => {
      usedAgentName = name;
      return makeMockAdapter(name, async () => ({ output: "judge output", costUsd: 0, source: "fallback" }));
    });

    const resolverConfig: ResolverConfig = {
      type: "custom",
      // No agent specified
    };

    await judgeResolver(["p1", "p2"], [], resolverConfig, {
      getAgent: getAgentFn,
      defaultAgentName: "default-claude",
    });

    expect(usedAgentName).toBe("default-claude");
  });

  test("falls back to a default agent when resolver.agent is unset and no defaultAgentName", async () => {
    let wasCalled = false;

    const getAgentFn = mock((_name: string) => {
      wasCalled = true;
      return makeMockAdapter("fallback", async () => ({ output: "fallback judge output", costUsd: 0, source: "fallback" }));
    });

    const resolverConfig: ResolverConfig = {
      type: "custom",
      // No agent, no default
    };

    // Should not throw — uses some default agent
    const result = await judgeResolver(["p1"], [], resolverConfig, {
      getAgent: getAgentFn,
    });

    expect(wasCalled).toBe(true);
    expect(result).toBeDefined();
    expect(result.output).toBe("fallback judge output");
  });
});
