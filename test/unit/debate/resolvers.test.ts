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

import { describe, expect, test } from "bun:test";
import {
  judgeResolver,
  majorityResolver,
  synthesisResolver,
} from "../../../src/debate/resolvers";
import type { CompleteOptions } from "../../../src/agents/types";
import type { Debater, ResolverConfig } from "../../../src/debate/types";
import { makeMockAgentManager } from "../../helpers";

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
  test("calls agentManager.completeAs() exactly once", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({ completeAsFn: async () => {
      callCount++;
      return { output: "synthesis output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await synthesisResolver(["proposal 1", "proposal 2", "proposal 3"], [], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
    });

    expect(callCount).toBe(1);
  });

  test("includes all proposals in the synthesis prompt", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await synthesisResolver(
      ["proposal A content", "proposal B content", "proposal C content"],
      [],
      { agentManager, agentName: "claude", completeOptions: {} as CompleteOptions },
    );

    expect(capturedPrompt).toContain("proposal A content");
    expect(capturedPrompt).toContain("proposal B content");
    expect(capturedPrompt).toContain("proposal C content");
  });

  test("includes all critiques in the synthesis prompt", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await synthesisResolver(["proposal 1"], ["critique X", "critique Y"], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
    });

    expect(capturedPrompt).toContain("critique X");
    expect(capturedPrompt).toContain("critique Y");
  });

  test("returns output and cost metadata from agentManager.completeAs()", async () => {
    const agentManager = makeMockAgentManager({ completeAsFn: async () => ({ output: "the synthesis result", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }) });

    const result = await synthesisResolver(["prop 1", "prop 2"], [], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
    });

    expect(result.output).toBe("the synthesis result");
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("works when critiques array is empty", async () => {
    const agentManager = makeMockAgentManager({ completeAsFn: async () => ({ output: "synthesis without critiques", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }) });

    const result = await synthesisResolver(["p1", "p2"], [], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
    });

    expect(result.output).toBe("synthesis without critiques");
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("preserves exact cost metadata from agentManager.completeAs()", async () => {
    const agentManager = makeMockAgentManager({ completeAsFn: async () => ({ output: "exact synthesis", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.42, exactCostUsd: 0.42 }) });

    const result = await synthesisResolver(["p1", "p2"], ["c1"], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
    });

    expect(result.output).toBe("exact synthesis");
    expect(result.estimatedCostUsd).toBeCloseTo(0.42, 6);
    expect(result.exactCostUsd).toBeCloseTo(0.42, 6);
  });

  test("forwards complete options to agentManager.completeAs()", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, _prompt, opts) => {
      capturedOptions = opts;
      return { output: "exact synthesis", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.42, exactCostUsd: 0.42 };
    } });

    const completeOptions = {
      model: "claude-sonnet-4-5",
      storyId: "US-001",
      sessionRole: "synthesis",
    } as CompleteOptions;

    await synthesisResolver(["p1", "p2"], ["c1"], {
      agentManager,
      agentName: "claude",
      completeOptions,
    });

    expect(capturedOptions?.model).toBe("claude-sonnet-4-5");
    expect(capturedOptions?.storyId).toBe("US-001");
    expect(capturedOptions?.sessionRole).toBe("synthesis");
  });
});

// ─── AC10: judgeResolver ─────────────────────────────────────────────────────

describe("judgeResolver()", () => {
  test("uses resolver.agent as the agent name passed to agentManager.completeAs()", async () => {
    let usedAgentName = "";

    const agentManager = makeMockAgentManager({ completeAsFn: async (name, _prompt, _opts) => {
      usedAgentName = name;
      return { output: "judge output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    const resolverConfig: ResolverConfig = {
      type: "custom",
      agent: "judge-agent",
    };

    await judgeResolver(["proposal 1", "proposal 2"], ["critique 1"], resolverConfig, {
      agentManager,
      completeOptions: {} as CompleteOptions,
    });

    expect(usedAgentName).toBe("judge-agent");
  });

  test("calls agentManager.completeAs() exactly once", async () => {
    let callCount = 0;

    const agentManager = makeMockAgentManager({ completeAsFn: async () => {
      callCount++;
      return { output: "judge output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await judgeResolver(["p1", "p2"], ["c1"], { type: "custom", agent: "judge" }, {
      agentManager,
      completeOptions: {} as CompleteOptions,
    });

    expect(callCount).toBe(1);
  });

  test("includes all proposals in the judge prompt", async () => {
    let capturedPrompt = "";

    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "judge output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await judgeResolver(
      ["proposal alpha", "proposal beta"],
      ["critique one"],
      { type: "custom", agent: "judge" },
      { agentManager, completeOptions: {} as CompleteOptions },
    );

    expect(capturedPrompt).toContain("proposal alpha");
    expect(capturedPrompt).toContain("proposal beta");
  });

  test("includes critiques in the judge prompt", async () => {
    let capturedPrompt = "";

    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "judge output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await judgeResolver(
      ["p1"],
      ["critique one", "critique two"],
      { type: "custom", agent: "judge" },
      { agentManager, completeOptions: {} as CompleteOptions },
    );

    expect(capturedPrompt).toContain("critique one");
    expect(capturedPrompt).toContain("critique two");
  });

  test("returns output and cost metadata from agentManager.completeAs()", async () => {
    const agentManager = makeMockAgentManager({ completeAsFn: async () => ({ output: "final judge verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }) });

    const result = await judgeResolver(["p1"], [], { type: "custom", agent: "judge" }, {
      agentManager,
      completeOptions: {} as CompleteOptions,
    });

    expect(result.output).toBe("final judge verdict");
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("preserves exact cost metadata from judge agentManager.completeAs()", async () => {
    const agentManager = makeMockAgentManager({ completeAsFn: async () => ({ output: "judge verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.55, exactCostUsd: 0.55 }) });

    const result = await judgeResolver(["p1"], ["c1"], { type: "custom", agent: "judge" }, {
      agentManager,
      completeOptions: {} as CompleteOptions,
    });

    expect(result.output).toBe("judge verdict");
    expect(result.estimatedCostUsd).toBeCloseTo(0.55, 6);
    expect(result.exactCostUsd).toBeCloseTo(0.55, 6);
  });

  test("uses defaultAgentName when resolver.agent is not specified", async () => {
    let usedAgentName = "";

    const agentManager = makeMockAgentManager({ completeAsFn: async (name, _prompt, _opts) => {
      usedAgentName = name;
      return { output: "judge output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    const resolverConfig: ResolverConfig = {
      type: "custom",
      // No agent specified
    };

    await judgeResolver(["p1", "p2"], [], resolverConfig, {
      agentManager,
      defaultAgentName: "default-claude",
      completeOptions: {} as CompleteOptions,
    });

    expect(usedAgentName).toBe("default-claude");
  });

  test("falls back to a default agent when resolver.agent is unset and no defaultAgentName", async () => {
    let wasCalled = false;

    const agentManager = makeMockAgentManager({ completeAsFn: async () => {
      wasCalled = true;
      return { output: "fallback judge output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    const resolverConfig: ResolverConfig = {
      type: "custom",
      // No agent, no default
    };

    // Should not throw — uses some default agent
    const result = await judgeResolver(["p1"], [], resolverConfig, {
      agentManager,
      completeOptions: {} as CompleteOptions,
    });

    expect(wasCalled).toBe(true);
    expect(result).toBeDefined();
    expect(result.output).toBe("fallback judge output");
  });

  test("forwards complete options to agentManager.completeAs()", async () => {
    let capturedOptions: CompleteOptions | undefined;
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, _prompt, opts) => {
      capturedOptions = opts;
      return { output: "judge verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.55, exactCostUsd: 0.55 };
    } });

    const completeOptions = {
      model: "claude-haiku-4-5",
      storyId: "US-002",
      sessionRole: "judge",
    } as CompleteOptions;

    await judgeResolver(["p1"], ["c1"], { type: "custom", agent: "judge" }, {
      agentManager,
      completeOptions,
    });

    expect(capturedOptions?.model).toBe("claude-haiku-4-5");
    expect(capturedOptions?.storyId).toBe("US-002");
    expect(capturedOptions?.sessionRole).toBe("judge");
  });
});

// ─── P2: Proposal labeling with persona ──────────────────────────────────────

describe("synthesisResolver() — persona-aware proposal labels (P2)", () => {
  test("labels proposals with agent+persona when debaters provided with personas", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    const debaters: Debater[] = [
      { agent: "claude", persona: "challenger" },
      { agent: "claude", persona: "pragmatist" },
      { agent: "claude", persona: "completionist" },
    ];

    await synthesisResolver(
      ["proposal A", "proposal B", "proposal C"],
      [],
      { agentManager, agentName: "claude", completeOptions: {} as CompleteOptions, debaters },
    );

    expect(capturedPrompt).toContain("### Proposal claude (challenger)");
    expect(capturedPrompt).toContain("### Proposal claude (pragmatist)");
    expect(capturedPrompt).toContain("### Proposal claude (completionist)");
    expect(capturedPrompt).toContain("proposal A");
    expect(capturedPrompt).toContain("proposal B");
    expect(capturedPrompt).toContain("proposal C");
  });

  test("labels proposals with agent name only when debaters have no persona", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    const debaters: Debater[] = [
      { agent: "claude" },
      { agent: "opencode" },
    ];

    await synthesisResolver(["proposal A", "proposal B"], [], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
      debaters,
    });

    expect(capturedPrompt).toContain("### Proposal claude");
    expect(capturedPrompt).toContain("### Proposal opencode");
    expect(capturedPrompt).not.toContain("(challenger)");
  });

  test("falls back to numeric labels when no debaters provided", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await synthesisResolver(["proposal A", "proposal B"], [], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
    });

    expect(capturedPrompt).toContain("### Proposal 1");
    expect(capturedPrompt).toContain("### Proposal 2");
  });

  test("mixed personas: labeled where present, agent name where absent", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    const debaters: Debater[] = [
      { agent: "claude", persona: "security" },
      { agent: "opencode" },
    ];

    await synthesisResolver(["proposal A", "proposal B"], [], {
      agentManager,
      agentName: "claude",
      completeOptions: {} as CompleteOptions,
      debaters,
    });

    expect(capturedPrompt).toContain("### Proposal claude (security)");
    expect(capturedPrompt).toContain("### Proposal opencode");
  });
});

describe("judgeResolver() — persona-aware proposal labels (P2)", () => {
  test("labels proposals with agent+persona when debaters provided with personas", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "synthesis output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    const debaters: Debater[] = [
      { agent: "claude", persona: "testability" },
      { agent: "claude", persona: "security" },
    ];

    await judgeResolver(["proposal A", "proposal B"], [], { type: "custom", agent: "judge" }, {
      agentManager,
      completeOptions: {} as CompleteOptions,
      debaters,
    });

    expect(capturedPrompt).toContain("### Proposal claude (testability)");
    expect(capturedPrompt).toContain("### Proposal claude (security)");
  });

  test("falls back to numeric labels when no debaters provided", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({ completeAsFn: async (_name, prompt) => {
      capturedPrompt = prompt;
      return { output: "verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    } });

    await judgeResolver(["p1", "p2"], [], { type: "custom", agent: "judge" }, {
      agentManager,
      completeOptions: {} as CompleteOptions,
    });

    expect(capturedPrompt).toContain("### Proposal 1");
    expect(capturedPrompt).toContain("### Proposal 2");
  });
});
