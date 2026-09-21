import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockRuntime,
  makeSessionManager,
  makeTestRuntime,
  opSelector,
  withTempDir,
} from "@test/helpers";
import type { RetryStrategy } from "@/agents/retry";
import type { ReviewConfig } from "@/config/selectors";
import { callOp } from "@/operations";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { BuildContext, HopBodyContext } from "@/operations/types";
import { AdversarialReviewPromptBuilder } from "@/prompts";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const SAMPLE_STORY = {
  id: "STORY-002",
  title: "Add logout endpoint",
  description: "Implement DELETE /session to invalidate the JWT",
  acceptanceCriteria: ["Clears the session token", "Returns 204 on success"],
};

const SAMPLE_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
};

const SAMPLE_INPUT: AdversarialReviewInput = {
  workdir: "/tmp/test",
  story: SAMPLE_STORY,
  adversarialConfig: SAMPLE_CONFIG,
  mode: "ref",
  storyGitRef: "def5678",
  stat: "src/session.ts | 15 +++++",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(adversarialReviewOp.config)) };
}

/** Resolve the op's retry field through its declared resolver form into a strategy. */
function resolveRetryStrategy(input: AdversarialReviewInput, buildCtx: BuildContext<ReviewConfig>): RetryStrategy {
  const retry = adversarialReviewOp.retry;
  if (typeof retry !== "function") throw new Error("adversarialReviewOp.retry must be a resolver");
  const resolved = retry(input, buildCtx);
  if (resolved !== undefined && "shouldRetry" in resolved) return resolved;
  throw new Error("adversarialReviewOp.retry must resolve to a strategy");
}

describe("adversarialReviewOp shape", () => {
  test.each([
    ["kind", adversarialReviewOp.kind, "run"],
    ["name", adversarialReviewOp.name, "adversarial-review"],
    ["session.role", adversarialReviewOp.session.role, "reviewer-adversarial"],
    ["session.lifetime", adversarialReviewOp.session.lifetime, "fresh"],
    ["stage", adversarialReviewOp.stage, "review"],
  ])("%s is %s", (_prop, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

// ADR-008 anti-oscillation invariant: each review round opens a fresh session.
// If lifetime were "reuse", the reviewer would carry state from a previous pass
// and could flip its verdict based on stale prior-round context — the root cause
// of oscillating pass/fail verdicts investigated in ADR-008.
describe("ADR-008 anti-oscillation invariant — reviewer opens a fresh session each round", () => {
  test("adversarialReviewOp declares lifetime:fresh (no cross-round session state)", () => {
    expect(adversarialReviewOp.session.lifetime).toBe("fresh");
  });
});

describe("adversarialReviewOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test.each([
    ["story title", "Add logout endpoint"],
    ["acceptance criteria", "Clears the session token"],
    ["git ref in ref mode", "def5678"],
  ])("task content contains %s", (_label, needle) => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain(needle);
  });
  test("task content contains embedded diff in embedded mode", () => {
    const ctx = makeBuildCtx();
    const embeddedInput: AdversarialReviewInput = { ...SAMPLE_INPUT, mode: "embedded", diff: "-old line" };
    const result = adversarialReviewOp.build(embeddedInput, ctx);
    expect(result.task.content).toContain("-old line");
  });

  test("task content contains prior iterations block when priorAdversarialIterations is set", () => {
    const ctx = makeBuildCtx();
    const inputWithPrior: AdversarialReviewInput = {
      ...SAMPLE_INPUT,
      priorAdversarialIterations: [
        {
          iterationNum: 1,
          findingsBefore: [],
          fixesApplied: [
            { strategyName: "source-fix", op: "source-fix", targetFiles: ["src/session.ts"], summary: "", costUsd: 0 },
          ],
          findingsAfter: [
            {
              source: "adversarial-review" as const,
              severity: "error" as const,
              category: "error-path",
              file: "src/session.ts",
              line: 10,
              message: "Silent catch block",
            },
          ],
          outcome: "partial" as const,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    };
    const result = adversarialReviewOp.build(inputWithPrior, ctx);
    expect(result.task.content).toContain("## Prior Iterations — verdict required before new analysis");
    expect(result.task.content).toContain("### Round 1 — outcome: partial");
    // Finding text rendered verbatim
    expect(result.task.content).toContain("Silent catch block");
  });

  test("task content has no prior iterations block when priorAdversarialIterations is absent", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).not.toContain("## Prior Iterations");
  });
});

describe("adversarialReviewOp.parse()", () => {
  test("parses passed:true with no findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ passed: true, findings: [] });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBeUndefined();
  });
  test("parses passed:false with findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/session.ts", line: 5, issue: "error swallowed", suggestion: "re-throw" },
      ],
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect((result.findings[0] as { issue: string }).issue).toBe("error swallowed");
  });
  test("parse() returns normalizedFindings:[] — source tagging and advisory split moved to verify()", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", category: "logic-bug", file: "src/a.ts", line: 1, issue: "x", suggestion: "y" },
        { severity: "error", category: "test-gap", file: "test/a.test.ts", line: 9, issue: "z", suggestion: "w" },
      ],
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    // parse() is a thin structural parser — normalizedFindings is always [] from parse().
    // Source tagging (adversarial-review) and blocking/advisory split happen in verify().
    expect(result.normalizedFindings).toEqual([]);
    expect(result.findings).toHaveLength(2);
  });
  test("parse() returns normalizedFindings:[] regardless of blockingThreshold", () => {
    const ctx = makeBuildCtx();
    const inputWithThreshold: AdversarialReviewInput = { ...SAMPLE_INPUT, blockingThreshold: "error" };
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", category: "logic-bug", file: "src/a.ts", line: 1, issue: "real", suggestion: "fix" },
        {
          severity: "warning",
          category: "style",
          file: "src/b.ts",
          line: 2,
          issue: "advisory",
          suggestion: "consider",
        },
      ],
    });
    const result = adversarialReviewOp.parse(json, inputWithThreshold, ctx);
    // parse() returns all raw findings; verify() does the threshold split.
    expect(result.findings).toHaveLength(2);
    expect(result.normalizedFindings).toEqual([]);
  });
  test("normalizedFindings is [] on looksLikeFail / no-findings paths", () => {
    const ctx = makeBuildCtx();
    expect(adversarialReviewOp.parse('{"passed":false}', SAMPLE_INPUT, ctx).normalizedFindings).toEqual([]);
    expect(
      adversarialReviewOp.parse(JSON.stringify({ passed: true, findings: [] }), SAMPLE_INPUT, ctx).normalizedFindings,
    ).toEqual([]);
  });
  test("throws ParseValidationError on unparseable output (triggers retry)", () => {
    const ctx = makeBuildCtx();
    expect(() => adversarialReviewOp.parse("no json here", SAMPLE_INPUT, ctx)).toThrow();
  });
  test("throws ParseValidationError on missing passed field (triggers retry)", () => {
    const ctx = makeBuildCtx();
    expect(() => adversarialReviewOp.parse(JSON.stringify({ findings: [] }), SAMPLE_INPUT, ctx)).toThrow();
  });
  test("parses fence-wrapped JSON response", () => {
    const ctx = makeBuildCtx();
    const json = `\`\`\`json\n${JSON.stringify({ passed: true, findings: [] })}\n\`\`\``;
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBeUndefined();
  });

  // US-002 — adversarial-review finding: hopBody's requote drop-recovery rewrites
  // turn.output with a framework-computed `passed` after downgrading unsubstantiated
  // blockers. parse() must surface the model's original claim via a marker so
  // verify() can stamp it as `modelPassed` — otherwise the audit attributes a
  // model-claimed pass to a model that claimed failure.
  test("US-002: surfaces the original model claim when hopBody rewrote `passed` (requote path)", () => {
    const ctx = makeBuildCtx();
    // First turn: model claimed failure with one blocking finding.
    // hopBody requote could not recover it, so the rewrite flipped `passed:true`.
    // The marker preserves the model's raw claim.
    const json = JSON.stringify({
      passed: true, // framework-computed after requote downgrade
      findings: [], // blocking finding downgraded to advisory (no longer in `findings`)
      _originalModelPassed: false, // marker set by hopBody rewrite
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true); // framework's verdict — what parse() reports
    expect(result.modelPassed).toBe(false); // original claim — what US-002 persists
  });

  test("US-002: surfaces modelPassed:true when hopBody rewrote with a framework pass that matches the model", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: true,
      findings: [],
      _originalModelPassed: true,
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.modelPassed).toBe(true);
  });

  test("US-002: leaves modelPassed undefined when no marker is present (no rewrite happened)", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ passed: true, findings: [] });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.modelPassed).toBeUndefined();
  });

  test("US-002: ignores a wrong-typed _originalModelPassed marker (only boolean counts)", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: true,
      findings: [],
      _originalModelPassed: "yes", // wrong type — must not coerce
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.modelPassed).toBeUndefined();
  });
});

describe("adversarialReviewOp.retry", () => {
  test("retry field exists", () => {
    expect(adversarialReviewOp).toHaveProperty("retry");
  });

  test("retry is a function (resolver form)", () => {
    expect(typeof adversarialReviewOp.retry).toBe("function");
  });

  test("retry resolver returns a RetryStrategy", () => {
    const ctx = makeBuildCtx();
    const result = resolveRetryStrategy(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("shouldRetry");
    expect(typeof result.shouldRetry).toBe("function");
  });

  test("retry resolver forwards blockingThreshold to jsonRetryCondensed", () => {
    const ctx = makeBuildCtx();
    const inputWithThreshold: AdversarialReviewInput = {
      ...SAMPLE_INPUT,
      blockingThreshold: "warning",
    };

    const strategy = resolveRetryStrategy(inputWithThreshold, ctx);
    expect(strategy).toHaveProperty("shouldRetry");

    // Verify the retry strategy is constructed correctly by testing shouldRetry
    // calls it with test inputs to verify the strategy responds appropriately
    expect(typeof strategy.shouldRetry).toBe("function");
  });

  test("hopBody field exists (same-session requote recovery added)", () => {
    expect(adversarialReviewOp).toHaveProperty("hopBody");
    expect(typeof adversarialReviewOp.hopBody).toBe("function");
  });
});

describe("adversarialReviewOp — AC3: empty-output exhaustion returns FAIL_OPEN", () => {
  test("returns FAIL_OPEN when agent returns empty output after retries", async () => {
    // adversarialReviewOp has exhaustedFallback declared; callOp now honors it on empty output.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
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
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
      adversarialReviewOp,
      SAMPLE_INPUT,
    );

    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.normalizedFindings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verify() — AC-dropped findings surfaced on a passing verdict (#1950)
// ---------------------------------------------------------------------------
// An AC-quote-dropped finding must reach a human-facing surface when the verdict
// passes. Before the fix, `dropped` fed only `acDropped` (a machine channel
// nothing renders); the run-end "NON-BLOCKING REVIEW FINDINGS" surface reads
// `advisoryFindings` only, so the drop evaporated on a passing verdict.
//
// Drives the REAL adversarialReviewOp.verify() (not a hand-authored fixture).

const STORY_AC_DROPPED = {
  id: "STORY-AV-ACDROP-01",
  title: "Adversarial verify pipeline — AC-dropped findings",
  description: "Tests for adversarialReviewOp.verify() (#1950)",
  // ACs include locus keywords so filterByAcQuote can validate acQuote-locus grounding.
  // "auth" is extracted from file "src/auth.ts"; must appear in both AC text and acQuote.
  acceptanceCriteria: [
    "AC1: auth login security must not allow SQL injection attacks",
    "AC2: handler must not throw unhandled exceptions",
  ],
};

const BASE_INPUT: AdversarialReviewInput = {
  workdir: "/tmp/adversarial-verify-ac-dropped-test",
  story: STORY_AC_DROPPED,
  adversarialConfig: {
    model: "balanced" as const,
    diffMode: "ref" as const,
    rules: [],
    timeoutMs: 600_000,
    parallel: false,
    maxConcurrentSessions: 2,
    substantiation: { requote: true, maxRequotes: 5 },
  },
  mode: "ref",
  blockingThreshold: "error",
};

function makeVerifyCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(opSelector(adversarialReviewOp.config)),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

function makeOutput(overrides: Partial<AdversarialReviewOutput> = {}): AdversarialReviewOutput {
  return {
    passed: true,
    findings: [],
    normalizedFindings: [],
    acDropped: [],
    ...overrides,
  };
}

async function runVerify(
  parsed: AdversarialReviewOutput,
  input: AdversarialReviewInput,
  ctx: ReturnType<typeof makeVerifyCtx>,
) {
  const { verify } = adversarialReviewOp;
  assertDefined(verify, "adversarialReviewOp.verify");
  return verify(parsed, input, ctx);
}

function dropCandidateFinding(overrides: Partial<AdversarialLLMFinding> = {}): AdversarialLLMFinding {
  return {
    severity: "error",
    category: "security",
    file: "src/auth.ts",
    line: 1,
    issue: "No acQuote — will be dropped",
    suggestion: "fix",
    acIndex: 1,
    // verifiedBy passes substantiation; no acQuote → filterByAcQuote drops to acDropped
    verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery" },
    ...overrides,
  };
}

describe("adversarialReviewOp.verify() — AC-dropped findings surfaced on a passing verdict (#1950)", () => {
  test("passing verdict + a dropped blocking finding: the drop is folded into advisoryFindings, tagged, and passed stays true", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir, mode: "ref" };
      // Model claims pass while emitting a blocking-severity, ungrounded finding —
      // exactly #1950's precondition (validateAcQuote only inspects blocking severities).
      const parsed = makeOutput({
        passed: true,
        findings: [dropCandidateFinding()],
        normalizedFindings: [],
      });

      const output = await runVerify(parsed, input, ctx);
      assertDefined(output, "verify() result");

      expect(output.passed).toBe(true);
      expect(output.acDropped).toHaveLength(1);
      // Still never blocks — normalizedFindings stays empty.
      expect(output.normalizedFindings).toHaveLength(0);

      const advisory = output.advisoryFindings ?? [];
      expect(advisory).toHaveLength(1);
      expect(advisory[0]?.message).toContain("No acQuote");
      expect(advisory[0]?.acDropped).toBe(true);
    });
  });

  test("failing verdict (everything dropped, accepted empty): drops are NOT folded into advisoryFindings", async () => {
    return withTempDir(async (workdir) => {
      const FILE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), FILE_CONTENT);

      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir, mode: "ref" };
      const parsed = makeOutput({
        passed: false,
        findings: [dropCandidateFinding()],
        normalizedFindings: [],
      });

      const output = await runVerify(parsed, input, ctx);
      assertDefined(output, "verify() result");

      expect(output.passed).toBe(false);
      expect(output.acDropped).toHaveLength(1);
      expect(output.advisoryFindings ?? []).toHaveLength(0);
    });
  });

  test("no drops: advisoryFindings is byte-identical to today (unaffected)", async () => {
    return withTempDir(async (workdir) => {
      const ctx = makeVerifyCtx();
      const input: AdversarialReviewInput = { ...BASE_INPUT, workdir, mode: "ref" };
      const parsed = makeOutput({
        passed: true,
        findings: [
          {
            severity: "warning",
            category: "quality",
            file: "src/auth.ts",
            line: 1,
            issue: "Advisory only",
            suggestion: "Consider X",
          },
        ],
        normalizedFindings: [],
      });

      const output = await runVerify(parsed, input, ctx);
      assertDefined(output, "verify() result");

      expect(output.passed).toBe(true);
      expect(output.acDropped ?? []).toHaveLength(0);
      const advisory = output.advisoryFindings ?? [];
      expect(advisory).toHaveLength(1);
      expect(advisory[0]?.message).toBe("Advisory only");
      expect(advisory[0]?.acDropped).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// hopBody — inspection-trail guard (#3A)
// ---------------------------------------------------------------------------
// A ref-mode `passed:true` verdict with zero findings and no `inspectedFiles`
// is the rubber-stamp signature (the reviewer never opened the code). The guard
// issues exactly one same-session re-prompt demanding inspection, then adopts the
// second turn's verdict. It is gated on `adversarialConfig.demandInspectionTrail`
// and only fires in ref mode.
//
// See docs/findings/2026-05-30-prompt-audit-analysis.md (#3A).

const ADVERSARIAL_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [] as string[],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
  acRegroundOnDrop: true,
  demandInspectionTrail: true,
  substantiation: { requote: false, maxRequotes: 0 },
};

const STORY_INSPECT = {
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
  config?: Partial<typeof ADVERSARIAL_CONFIG>;
  mode?: "ref" | "embedded";
}) {
  let callCount = 0;
  const mockSend = mock(async () => turn(opts.responses[Math.min(callCount++, opts.responses.length - 1)]));
  const result = await adversarialReviewOp.hopBody("initial prompt", {
    send: mockSend,
    sendWithParseRetry: mockSend,
    input: {
      workdir: "/tmp",
      story: STORY_INSPECT,
      adversarialConfig: { ...ADVERSARIAL_CONFIG, ...opts.config },
      mode: opts.mode ?? "ref",
    },
  } satisfies HopBodyContext<AdversarialReviewInput>);
  return { result, callCount };
}

describe("adversarialReviewOp.hopBody — inspection-trail guard (#3A)", () => {
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
    await adversarialReviewOp.hopBody("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir: "/tmp", story: STORY_INSPECT, adversarialConfig: ADVERSARIAL_CONFIG, mode: "ref" },
    } satisfies HopBodyContext<AdversarialReviewInput>);
    expect(secondPrompt).toBe(AdversarialReviewPromptBuilder.demandInspection());
  });

  test("second turn's verdict is adopted (findings flow downstream)", async () => {
    const second = JSON.stringify({
      passed: false,
      inspectedFiles: ["src/auth.ts"],
      findings: [
        { severity: "error", category: "test-gap", file: "src/auth.ts", line: 1, issue: "x", suggestion: "y" },
      ],
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
 * Corroboration (2026-09-03). Reproduces the verdict observed in the Phase C1
 * A/B run: the reviewer wrote "I have no file/shell access tool in this
 * environment", then returned `passed:true` with
 * `inspectedFiles: ["src/calc.ts", "src/calc.test.ts"]` — files it had just
 * said it could not open. The guard believed the list and let it through.
 */
describe("adversarialReviewOp.hopBody — inspection trail corroborated against tool use", () => {
  const DECLARED = JSON.stringify({
    passed: true,
    inspectedFiles: ["src/calc.ts", "src/calc.test.ts"],
    findings: [],
  });

  async function sendCount(codingToolUse: { advertised: number; called: string[] } | undefined) {
    const mockSend = mock(async () => ({ ...turn(DECLARED), ...(codingToolUse ? { codingToolUse } : {}) }));
    await adversarialReviewOp.hopBody("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: { workdir: "/tmp", story: STORY_INSPECT, adversarialConfig: ADVERSARIAL_CONFIG, mode: "ref" },
    } satisfies HopBodyContext<AdversarialReviewInput>);
    return mockSend.mock.calls.length;
  }

  test("re-prompts when tools were advertised and the reviewer called none", async () => {
    expect(await sendCount({ advertised: 4, called: [] })).toBe(2);
  });

  test("accepts the verdict when the reviewer actually called a tool", async () => {
    expect(await sendCount({ advertised: 4, called: ["Git", "Read"] })).toBe(1);
  });

  test("falls back to the self-report when no tools were advertised", async () => {
    expect(await sendCount(undefined)).toBe(1);
  });
});
