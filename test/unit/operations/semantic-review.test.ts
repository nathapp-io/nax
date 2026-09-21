import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockRuntime,
  makeSessionManager,
  makeTestRuntime,
  opSelector,
} from "@test/helpers";
import type { Iteration } from "@/findings";
import { callOp } from "@/operations";
import type { SemanticReviewInput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { HopBodyContext } from "@/operations/types";
import { ReviewPromptBuilder } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const SAMPLE_STORY = {
  id: "STORY-001",
  title: "Add login endpoint",
  description: "Implement POST /login returning a JWT",
  acceptanceCriteria: ["Returns 200 on valid credentials", "Returns 401 on invalid credentials"],
};

const SAMPLE_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 600_000,
  substantiation: { requote: true, maxRequotes: 5 },
};

const SAMPLE_INPUT: SemanticReviewInput = {
  workdir: "/tmp/wd",
  story: SAMPLE_STORY,
  semanticConfig: SAMPLE_CONFIG,
  mode: "ref",
  storyGitRef: "abc1234",
  stat: "src/auth.ts | 20 +++++",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(semanticReviewOp.config)) };
}

describe("semanticReviewOp shape", () => {
  test.each([
    ["kind", semanticReviewOp.kind, "run"],
    ["name", semanticReviewOp.name, "semantic-review"],
    ["session.role", semanticReviewOp.session.role, "reviewer-semantic"],
    ["session.lifetime", semanticReviewOp.session.lifetime, "fresh"],
    ["stage", semanticReviewOp.stage, "review"],
  ])("%s is %s", (_prop, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

// ADR-008 anti-oscillation invariant: each review round opens a fresh session.
// If lifetime were "reuse", the reviewer would carry state from a previous pass
// and could flip its verdict based on stale prior-round context — the root cause
// of oscillating pass/fail verdicts investigated in ADR-008.
describe("ADR-008 anti-oscillation invariant — reviewer opens a fresh session each round", () => {
  test("semanticReviewOp declares lifetime:fresh (no cross-round session state)", () => {
    expect(semanticReviewOp.session.lifetime).toBe("fresh");
  });
});

describe("semanticReviewOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test.each([
    ["story title", "Add login endpoint"],
    ["acceptance criteria", "Returns 200 on valid credentials"],
    ["git ref in ref mode", "abc1234"],
  ])("task content contains %s", (_label, needle) => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain(needle);
  });
  test("task content contains embedded diff in embedded mode", () => {
    const ctx = makeBuildCtx();
    const embeddedInput: SemanticReviewInput = { ...SAMPLE_INPUT, mode: "embedded", diff: "+const x = 1;" };
    const result = semanticReviewOp.build(embeddedInput, ctx);
    expect(result.task.content).toContain("+const x = 1;");
  });
});

describe("semanticReviewOp.build() — priorSemanticIterations", () => {
  test("includes prior iterations block when priorSemanticIterations has entries", () => {
    const ctx = makeBuildCtx();
    const iteration: Iteration = {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [
        { source: "semantic-review", message: "handler not wired", severity: "error", category: "ac-coverage" },
      ],
      outcome: "partial",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    };
    const inputWithIterations: SemanticReviewInput = {
      ...SAMPLE_INPUT,
      priorSemanticIterations: [iteration],
    };
    const result = semanticReviewOp.build(inputWithIterations, ctx);
    expect(result.task.content).toContain("## Prior Iterations — verdict required before new analysis");
    expect(result.task.content).toContain("### Round 1 — outcome: partial");
    // Finding text rendered verbatim
    expect(result.task.content).toContain("handler not wired");
  });

  test("omits prior iterations block when priorSemanticIterations is undefined", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).not.toContain("## Prior Iterations");
  });
});

describe("semanticReviewOp.parse()", () => {
  test("parses passed:true with no findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ passed: true, findings: [] });
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBeUndefined();
  });
  test("parses passed:false with findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/auth.ts", line: 10, issue: "missing check", suggestion: "add guard" }],
    });
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect((result.findings[0] as { severity: string }).severity).toBe("error");
  });
  test("returns fail-open for unparseable output (retry handled in hopBody, not callOp parse)", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse("not json", SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
  });
  test("returns fail-open for missing passed field (retry handled in hopBody, not callOp parse)", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse(JSON.stringify({ findings: [] }), SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
  });
  test("parses fence-wrapped JSON response", () => {
    const ctx = makeBuildCtx();
    const json = `\`\`\`json\n${JSON.stringify({ passed: true, findings: [] })}\n\`\`\``;
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBeUndefined();
  });
  test("preserves a valid reprompt telemetry marker", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse(
      JSON.stringify({
        passed: true,
        findings: [],
        _repromptInfo: { dropCount: 2, outcome: "recovered-advisory-only", costUsd: 0.03 },
      }),
      SAMPLE_INPUT,
      ctx,
    );
    expect(result.repromptEvent).toEqual({ dropCount: 2, outcome: "recovered-advisory-only", costUsd: 0.03 });
  });
  test("parse() returns normalizedFindings:[] — advisory split moved to verify()", () => {
    // parse() is no longer responsible for the advisory split or source-tagging.
    // Those responsibilities moved to verify(), which runs the full filter pipeline
    // (sanitize → substantiate → AC-ground → blocking split). Tests for that
    // pipeline live in test/unit/operations/semantic-review-verify.test.ts.
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "x", suggestion: "y", acIndex: 1 },
        { severity: "warning", file: "src/b.ts", line: 2, issue: "advisory", suggestion: "consider" },
      ],
    });
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    // Raw findings preserved for verify() to process.
    expect(result.findings).toHaveLength(2);
    // normalizedFindings is always [] from parse(); populated only after verify() runs.
    expect(result.normalizedFindings).toEqual([]);
  });
  test("normalizedFindings is [] on fail-open / looksLikeFail / no-findings paths", () => {
    const ctx = makeBuildCtx();
    expect(semanticReviewOp.parse("not json", SAMPLE_INPUT, ctx).normalizedFindings).toEqual([]);
    expect(semanticReviewOp.parse('{"passed":false}', SAMPLE_INPUT, ctx).normalizedFindings).toEqual([]);
    expect(
      semanticReviewOp.parse(JSON.stringify({ passed: true, findings: [] }), SAMPLE_INPUT, ctx).normalizedFindings,
    ).toEqual([]);
  });
});

describe("semanticReviewOp.hopBody", () => {
  test("hopBody field exists (semantic uses multi-turn for requote recovery)", () => {
    expect(semanticReviewOp).toHaveProperty("hopBody");
  });

  test("hopBody is an async function", () => {
    expect(typeof semanticReviewOp.hopBody).toBe("function");
  });

  test("retry field exists (parse-retry SSOT)", () => {
    expect(semanticReviewOp).toHaveProperty("retry");
  });
});

describe("semanticReviewOp — US-002 AC4: a completed dispatch still fails open", () => {
  test("returns FAIL_OPEN when a completed dispatch returns empty output after retries", async () => {
    // semanticReviewOp now has exhaustedFallback; empty-output exhaustion should
    // produce the same FAIL_OPEN that parse failure already produces.
    //
    // `dispatchesCompleted: 1` states the case being simulated (US-002): the hop
    // DID reach a model and returned a turn — the turn was empty. Only a dispatch
    // that never completed is a `noDispatch` failure, so an unusable turn still
    // takes the fail-open verdict.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      semanticReviewOp,
      SAMPLE_INPUT,
    );

    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.normalizedFindings).toEqual([]);
    expect((result as { noDispatch?: boolean }).noDispatch).not.toBe(true);
  });

  test("returns FAIL_OPEN for a completed dispatch whose non-empty output is unparseable", async () => {
    // The genuine give-up path US-002 must not disturb: a model WAS reached and
    // answered, we just could not use the answer. `noDispatch` is reserved for
    // the case where no turn ever came back.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      runAsSessionFn: async () => ({
        output: "I will not comply with this request.",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      semanticReviewOp,
      SAMPLE_INPUT,
    );

    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect((result as { noDispatch?: boolean }).noDispatch).not.toBe(true);
  });

  test("parse-failure path still returns FAIL_OPEN — no regression", () => {
    // Direct parse call with unparseable output should still return FAIL_OPEN (existing behavior).
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse("not json at all", SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.normalizedFindings).toEqual([]);
  });
});

/**
 * Tests for semanticReviewOp.hopBody — inspection-trail guard (#3A).
 *
 * A ref-mode `passed:true` verdict with zero findings and no `inspectedFiles`
 * is the rubber-stamp signature (the reviewer never opened the code). The guard
 * issues exactly one same-session re-prompt demanding inspection, then adopts the
 * second turn's verdict. It is gated on `semanticConfig.demandInspectionTrail`
 * and only fires in ref mode.
 *
 * See docs/findings/2026-05-30-prompt-audit-analysis.md (#3A).
 */
const SEMANTIC_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  resetRefOnRerun: false,
  rules: [] as string[],
  timeoutMs: 600_000,
  substantiation: { requote: false, maxRequotes: 0 },
  acRegroundOnDrop: true,
  demandInspectionTrail: true,
};

const STORY = {
  id: "STORY-INSPECT",
  title: "Inspection trail guard",
  description: "guard against rubber-stamp reviews",
  acceptanceCriteria: ["auth login must not allow SQL injection attacks"],
};

function turn(output: string) {
  return { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0, internalRoundTrips: 0 };
}

async function runHopBody(opts: {
  responses: string[];
  config?: Partial<typeof SEMANTIC_CONFIG>;
  mode?: "ref" | "embedded";
}) {
  let callCount = 0;
  const mockSend = mock(async () => turn(opts.responses[Math.min(callCount++, opts.responses.length - 1)]));
  const result = await semanticReviewOp.hopBody("initial prompt", {
    send: mockSend,
    sendWithParseRetry: mockSend,
    input: {
      workdir: "/tmp",
      story: STORY,
      semanticConfig: { ...SEMANTIC_CONFIG, ...opts.config },
      mode: opts.mode ?? "ref",
    },
  } satisfies HopBodyContext<SemanticReviewInput>);
  return { result, callCount };
}

describe("semanticReviewOp.hopBody — inspection-trail guard (#3A)", () => {
  const RUBBER_STAMP = JSON.stringify({ passed: true, findings: [] });

  test("empty pass with no inspectedFiles → one re-prompt (two sends)", async () => {
    const second = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });
    const { callCount } = await runHopBody({ responses: [RUBBER_STAMP, second] });
    expect(callCount).toBe(2);
  });

  test("re-prompt uses the demandInspection prompt", async () => {
    let secondPrompt: string | undefined;
    let n = 0;
    const second = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });
    const mockSend = mock(async (p: string) => {
      if (n === 1) secondPrompt = p;
      n += 1;
      return turn(n === 1 ? RUBBER_STAMP : second);
    });
    await semanticReviewOp.hopBody("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir: "/tmp", story: STORY, semanticConfig: SEMANTIC_CONFIG, mode: "ref" },
    } satisfies HopBodyContext<SemanticReviewInput>);
    expect(secondPrompt).toBe(ReviewPromptBuilder.demandInspection());
  });

  test("second turn's verdict is adopted", async () => {
    const second = JSON.stringify({
      passed: false,
      inspectedFiles: ["src/auth.ts"],
      findings: [{ severity: "error", file: "src/auth.ts", line: 1, issue: "x", suggestion: "y", acIndex: 1 }],
    });
    const { result } = await runHopBody({ responses: [RUBBER_STAMP, second] });
    expect(result.output).toBe(second);
  });

  test("empty pass WITH inspectedFiles → no re-prompt (single send)", async () => {
    const passed = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });
    const { callCount } = await runHopBody({ responses: [passed] });
    expect(callCount).toBe(1);
  });

  test("demandInspectionTrail:false → no re-prompt", async () => {
    const { callCount } = await runHopBody({
      responses: [RUBBER_STAMP],
      config: { demandInspectionTrail: false },
    });
    expect(callCount).toBe(1);
  });

  test("embedded mode → guard does not fire (ref-only)", async () => {
    const { callCount } = await runHopBody({ responses: [RUBBER_STAMP], mode: "embedded" });
    expect(callCount).toBe(1);
  });

  test("unparseable second turn → keep original pass, still two sends", async () => {
    const { result, callCount } = await runHopBody({ responses: [RUBBER_STAMP, "not json at all"] });
    expect(callCount).toBe(2);
    expect(result.output).toBe(RUBBER_STAMP);
  });
});

/**
 * Corroboration (2026-09-03). The guard above trusts `inspectedFiles` because
 * it is the only signal it has. A native reviewer with no tools wired up
 * returned `passed:true` with two filenames it had, in the same response, said
 * it could not open — and sailed through.
 *
 * When coding tools were advertised the turn reports what was actually called,
 * so the self-report can be checked rather than believed. When none were
 * advertised there is nothing to check against and the old rule stands, which
 * is what keeps the acpx path unchanged.
 */
describe("semanticReviewOp.hopBody — inspection trail corroborated against tool use", () => {
  const DECLARED = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });
  const SECOND = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });

  async function runWithToolUse(codingToolUse: { advertised: number; called: string[] } | undefined) {
    let n = 0;
    const mockSend = mock(async () => ({
      ...turn(n++ === 0 ? DECLARED : SECOND),
      ...(codingToolUse ? { codingToolUse } : {}),
    }));
    await semanticReviewOp.hopBody("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir: "/tmp", story: STORY, semanticConfig: SEMANTIC_CONFIG, mode: "ref" },
    } satisfies HopBodyContext<SemanticReviewInput>);
    return mockSend.mock.calls.length;
  }

  test("re-prompts when tools were advertised and the reviewer called none", async () => {
    expect(await runWithToolUse({ advertised: 4, called: [] })).toBe(2);
  });

  test("accepts the verdict when the reviewer actually called a tool", async () => {
    expect(await runWithToolUse({ advertised: 4, called: ["Read"] })).toBe(1);
  });

  test("falls back to the self-report when no tools were advertised", async () => {
    expect(await runWithToolUse(undefined)).toBe(1);
  });
});
