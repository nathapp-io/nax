/**
 * Tests for adversarialReviewOp.hopBody — same-session requote recovery (AC15, AC16).
 *
 * Run RED first (hopBody is undefined), then implement in Task 16.
 *
 * AC15: adversarialReviewOp has a hopBody
 * AC16: hopBody triggers same-session requote for blocking findings with unmatched evidence
 *        (mirrors semantic side, uses AdversarialReviewPromptBuilder.requoteVerbatim)
 *
 * Also hosts the retired hopBody's retry flip (US-005c): hopBody is deleted,
 * `retry` is active and provides the same behavior, cost accumulation works,
 * logging preserves storyId as first key.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeLogger,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
  makeTurnResult,
  withTempDir,
} from "@test/helpers";
import type { AgentRunRequest, RetryStrategy } from "@/agents";
import { ParseValidationError } from "@/agents";
import type { ConfigSelector, NaxConfig } from "@/config";
import type { ReviewConfig } from "@/config/selectors";
import * as loggerModule from "@/logger";
import { _callOpDeps, adversarialReviewOp, type BuildContext, type CallContext, callOp } from "@/operations";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import type { NaxRuntime, PackageView } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY = {
  id: "STORY-AV-REQ01",
  title: "Adversarial requote test",
  description: "same-session requote recovery",
  acceptanceCriteria: [
    "AC1: auth login must not allow SQL injection attacks",
    "AC2: handler must not throw unhandled exceptions",
  ],
};

const ADVERSARIAL_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
  substantiation: { requote: true, maxRequotes: 5 },
};

// ---------------------------------------------------------------------------
// hopBody existence checks (RED: hopBody is undefined before Task 16)
// ---------------------------------------------------------------------------

describe("adversarialReviewOp.hopBody — existence (AC15)", () => {
  test("hopBody field exists on the op", () => {
    expect(adversarialReviewOp).toHaveProperty("hopBody");
  });

  test("hopBody is an async function", () => {
    expect(typeof adversarialReviewOp.hopBody).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// hopBody behaviour — requote recovery (AC16)
// ---------------------------------------------------------------------------

describe("adversarialReviewOp.hopBody — same-session requote (AC16)", () => {
  test("recovers a blocking finding when requote returns a verbatim matching excerpt", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection via rawQuery",
            suggestion: "Use parameterized queries",
            acQuote: "auth login must not allow SQL injection",
            acIndex: 1,
            verifiedBy: {
              file: "src/auth.ts",
              line: 1,
              // Wrong observed — does not match disk content
              observed: "some wrong description from memory",
            },
          },
        ],
      });
      const requote = JSON.stringify({
        file: "src/auth.ts",
        line: 1,
        // Matches file content
        observed: "db.rawQuery(u + p)",
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return makeTurnResult({ output: callCount === 1 ? initial : requote });
      });

      const result = await adversarialReviewOp.hopBody("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          adversarialConfig: { ...ADVERSARIAL_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      // Two calls: initial + requote
      expect(callCount).toBe(2);
      // Finding severity unchanged (requote succeeded)
      expect(parsed.findings[0].severity).toBe("error");
      // verifiedBy.observed updated with the requoted value
      expect(parsed.findings[0].verifiedBy.observed).toContain("db.rawQuery");
    });
  });

  test("preserves acks across the requote output rewrite (#1423)", async () => {
    // hopBody synthesises a replacement output string; parse() reads THAT object,
    // so anything the rewrite forgets is gone. Acks exist only on rounds with
    // prior findings — exactly the rounds where requote is most likely to fire.
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const initial = JSON.stringify({
        passed: false,
        acks: [{ priorFinding: "src/old.ts:3", status: "addressed", note: "fixed in this diff" }],
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection via rawQuery",
            suggestion: "Use parameterized queries",
            acQuote: "auth login must not allow SQL injection",
            acIndex: 1,
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "wrong quote from memory" },
          },
        ],
      });
      const requote = JSON.stringify({ file: "src/auth.ts", line: 1, observed: "db.rawQuery(u + p)" });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return makeTurnResult({ output: callCount === 1 ? initial : requote });
      });

      const result = await adversarialReviewOp.hopBody("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          adversarialConfig: { ...ADVERSARIAL_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      expect(parsed.findings[0].verifiedBy.observed).toContain("db.rawQuery");
      expect(parsed.acks).toEqual([{ priorFinding: "src/old.ts:3", status: "addressed", note: "fixed in this diff" }]);
    });
  });

  test("downgrades finding when requote response is invalid JSON", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection",
            suggestion: "Use parameterized queries",
            acQuote: "auth login must not allow SQL injection",
            acIndex: 1,
            verifiedBy: {
              file: "src/auth.ts",
              line: 1,
              observed: "not on disk at all",
            },
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return makeTurnResult({ output: callCount === 1 ? initial : "not valid json response" });
      });

      const result = await adversarialReviewOp.hopBody("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          adversarialConfig: { ...ADVERSARIAL_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      expect(callCount).toBe(2);
      // Finding downgraded to unverifiable when requote returns invalid JSON
      expect(parsed.findings[0].severity).toBe("unverifiable");
    });
  });

  test("skips requote when mode is embedded", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection",
            suggestion: "Use parameterized queries",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "wrong" },
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return makeTurnResult({ output: initial });
      });

      const result = await adversarialReviewOp.hopBody("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          adversarialConfig: { ...ADVERSARIAL_CONFIG, diffMode: "embedded" },
          mode: "embedded",
        },
      });

      // Only one call (no requote in embedded mode)
      expect(callCount).toBe(1);
      // Output unchanged
      expect(result.output).toBe(initial);
    });
  });

  test("skips requote when substantiation.requote is false", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection",
            suggestion: "Use parameterized queries",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "wrong" },
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return makeTurnResult({ output: initial });
      });

      const result = await adversarialReviewOp.hopBody("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          adversarialConfig: {
            ...ADVERSARIAL_CONFIG,
            substantiation: { requote: false, maxRequotes: 5 },
            acRegroundOnDrop: false,
          },
          mode: "ref",
        },
      });

      // Only one call (requote disabled)
      expect(callCount).toBe(1);
      expect(result.output).toBe(initial);
    });
  });

  test("skips requote when maxRequotes is 0", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection",
            suggestion: "Use parameterized queries",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "wrong" },
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return makeTurnResult({ output: initial });
      });

      const result = await adversarialReviewOp.hopBody("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          adversarialConfig: {
            ...ADVERSARIAL_CONFIG,
            substantiation: { requote: true, maxRequotes: 0 },
            acRegroundOnDrop: false,
          },
          mode: "ref",
        },
      });

      // Only one call (maxRequotes: 0)
      expect(callCount).toBe(1);
      expect(result.output).toBe(initial);
    });
  });

  test("no-op when findings are empty (no requote needed)", async () => {
    // inspectedFiles present → the #3A inspection-trail guard is satisfied,
    // so this test isolates the requote no-op (no findings to requote).
    const initial = JSON.stringify({ passed: true, inspectedFiles: ["src/foo.ts"], findings: [] });

    let callCount = 0;
    const mockSend = mock(async () => {
      callCount += 1;
      return makeTurnResult({ output: initial });
    });

    const result = await adversarialReviewOp.hopBody("initial prompt", {
      send: mockSend,
      sendWithParseRetry: mockSend,
      input: {
        workdir: "/tmp",
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        mode: "ref",
      },
    });

    // Only one call (no findings)
    expect(callCount).toBe(1);
    expect(result.output).toBe(initial);
  });
});

/**
 * `RunOperation.config` is declared as a selector-or-key-list union; this op's
 * actual value is always the selector half, so narrow before handing it to
 * `view.select`.
 */
function isConfigSelector<C>(
  candidate: ConfigSelector<C> | readonly (keyof NaxConfig)[],
): candidate is ConfigSelector<C> {
  return !Array.isArray(candidate);
}

function selectOpConfig(view: PackageView): ReviewConfig {
  const selector = adversarialReviewOp.config;
  if (!isConfigSelector(selector)) throw new Error("adversarialReviewOp.config must be a ConfigSelector");
  return view.select(selector);
}

/** Resolve the op's retry field through its declared resolver form into a strategy. */
function resolveRetryStrategy(input: AdversarialReviewInput, buildCtx: BuildContext<ReviewConfig>): RetryStrategy {
  const retry = adversarialReviewOp.retry;
  if (typeof retry !== "function") throw new Error("adversarialReviewOp.retry must be a resolver");
  const resolved = retry(input, buildCtx);
  if (resolved !== undefined && "shouldRetry" in resolved) return resolved;
  throw new Error("adversarialReviewOp.retry must resolve to a strategy");
}

/**
 * callOp injects the accumulated hop cost onto the returned value at runtime
 * without declaring it on `O` — narrow through a predicate instead of casting.
 */
function hasEstimatedCostUsd(
  value: AdversarialReviewOutput,
): value is AdversarialReviewOutput & { estimatedCostUsd: number } {
  return "estimatedCostUsd" in value;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

const VALID_JSON_OUTPUT = JSON.stringify({ passed: true, findings: [] });

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: selectOpConfig(view) };
}

// ─── AC2: Valid JSON = 1 send() call ─────────────────────────────────────────

describe("AC2: retry behavior — valid JSON response", () => {
  test("retry strategy does not retry when parse succeeds", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    expect(typeof strategy.shouldRetry).toBe("function");
  });

  test("parse receives valid JSON and returns parsed result", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.parse(VALID_JSON_OUTPUT, SAMPLE_INPUT, ctx);

    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBeUndefined();
    expect(result.looksLikeFail).toBeUndefined();
  });
});

// ─── AC3: Invalid+truncated = jsonRetryCondensed with blockingThreshold ──────

describe("AC3: retry behavior — truncated JSON response", () => {
  test("retry strategy detects truncated response and returns retry decision", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const inputWithThreshold: AdversarialReviewInput = {
      ...SAMPLE_INPUT,
      blockingThreshold: "warning",
    };
    const strategy = resolveRetryStrategy(inputWithThreshold, opCtx);

    // Unfinished JSON — an object opened and never closed, which is what
    // looksLikeTruncatedJson() detects now that nothing truncates by length.
    const truncatedOutput = `{"passed": false, "findings": [{"severity": "error", "issue": "cut`;

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: truncatedOutput,
    };

    const result = strategy.shouldRetry(new ParseValidationError("JSON shape validation failed"), 0, retryCtx);

    expect(result.retry).toBe(true);
    if (!result.retry) throw new Error("expected a retry decision");
    expect(result.delayMs).toBeDefined();
    expect(result.nextPrompt).toBeDefined();
  });

  test("condensed retry prompt contains 'truncated'", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const result = strategy.shouldRetry(new ParseValidationError("parse failed"), 0, {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: '{"passed": false, "findings": [{"severity": "error", "issue": "cut',
    });

    expect(result.retry).toBe(true);
    if (!result.retry) throw new Error("expected a retry decision");
    expect(result.nextPrompt).toContain("truncated");
  });
});

// ─── AC4: Invalid+non-truncated = jsonRetry prompt ──────────────────────────

describe("AC4: retry behavior — invalid but non-truncated response", () => {
  test("retry strategy detects invalid non-truncated response and retries", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const shortInvalidOutput = "this is not valid JSON at all";

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: shortInvalidOutput,
    };

    const result = strategy.shouldRetry(new ParseValidationError("JSON parsing failed"), 0, retryCtx);

    expect(result.retry).toBe(true);
    if (!result.retry) throw new Error("expected a retry decision");
    expect(result.nextPrompt).not.toContain("truncated");
  });
});

// ─── AC5: budget exhaustion at the configured maxAttempts (default 3, parse-retry budget) ───

describe("AC5: retry behavior — budget exhaustion at review.parseRetryMaxAttempts (default 3)", () => {
  test("retry strategy does not retry after maxAttempts exhausted", () => {
    const ctx = makeBuildCtx();
    const opCtx = { packageView: ctx.packageView, config: ctx.config };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const invalidOutput = "not json";

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: invalidOutput,
    };

    // Default review.parseRetryMaxAttempts is 3 (BUG-62 parse-retry budget) — attempts
    // 0 and 1 retry; attempt 2 (the 3rd call) exhausts the budget.
    const firstResult = strategy.shouldRetry(new ParseValidationError("Parse failed"), 0, retryCtx);
    expect(firstResult.retry).toBe(true);

    const secondResult = strategy.shouldRetry(new ParseValidationError("Parse failed again"), 1, retryCtx);
    expect(secondResult.retry).toBe(true);

    const thirdResult = strategy.shouldRetry(new ParseValidationError("Parse failed a third time"), 2, retryCtx);
    expect(thirdResult.retry).toBe(false);
  });

  test("a lower review.parseRetryMaxAttempts override exhausts sooner", () => {
    const runtime = makeTestRuntime({ config: makeNaxConfig({ review: { parseRetryMaxAttempts: 2 } }) });
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const opCtx = { packageView: view, config: selectOpConfig(view) };
    const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

    const retryCtx = {
      site: "complete" as const,
      agentName: "claude",
      stage: "review" as const,
      storyId: SAMPLE_STORY.id,
      lastOutput: "not json",
    };

    expect(strategy.shouldRetry(new ParseValidationError("Parse failed"), 0, retryCtx).retry).toBe(true);
    expect(strategy.shouldRetry(new ParseValidationError("Parse failed again"), 1, retryCtx).retry).toBe(false);
  });
});

// ─── AC6: cost accumulation = sum of all turns ───────────────────────────────

describe("AC6: cost accumulation — estimatedCostUsd sums all turns", () => {
  test("callOp accumulates estimatedCostUsd across all retry turns up to the default budget", async () => {
    let turnCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        turnCount++;
        return {
          output: "not valid json output",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: turnCount * 0.001,
          internalRoundTrips: 0,
        };
      },
    });

    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const originalParse = adversarialReviewOp.parse;
    Object.assign(adversarialReviewOp, {
      parse: () => {
        throw new ParseValidationError("invalid shape — triggers retry");
      },
    });

    const origSleep = _callOpDeps.sleep;
    _callOpDeps.sleep = async () => {};

    let result: AdversarialReviewOutput | undefined;
    try {
      const ctx: CallContext = {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp/test",
        storyId: SAMPLE_STORY.id,
        featureName: "_test",
        agentName: "claude",
      };
      result = await callOp(ctx, adversarialReviewOp, SAMPLE_INPUT);
    } finally {
      Object.assign(adversarialReviewOp, { parse: originalParse });
      _callOpDeps.sleep = origSleep;
    }

    // Default review.parseRetryMaxAttempts is 3 — one initial call + two re-prompts.
    assertDefined(result, "callOp result");
    if (!hasEstimatedCostUsd(result)) throw new Error("callOp did not surface estimatedCostUsd");
    expect(turnCount).toBe(3);
    expect(result.estimatedCostUsd).toBeCloseTo(0.001 + 0.002 + 0.003, 6);
  });
});

// ─── AC7: Warn log on parse failure has storyId first ──────────────────────

describe("AC7: logging — storyId is first key in data object", () => {
  test("warn logs on JSON parse retry include storyId as first key", () => {
    const logger = makeLogger();
    const spy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    try {
      const ctx = makeBuildCtx();
      const opCtx = { packageView: ctx.packageView, config: ctx.config };
      const strategy = resolveRetryStrategy(SAMPLE_INPUT, opCtx);

      // Unfinished JSON — an object opened and never closed, which is what
      // looksLikeTruncatedJson() detects now that nothing truncates by length.
      const truncatedOutput = `{"passed": false, "findings": [{"severity": "error", "issue": "cut`;

      const retryCtx = {
        site: "complete" as const,
        agentName: "claude",
        stage: "review" as const,
        storyId: SAMPLE_STORY.id,
        lastOutput: truncatedOutput,
      };

      const result = strategy.shouldRetry(new ParseValidationError("JSON parse failed"), 0, retryCtx);

      expect(result.retry).toBe(true);

      for (const call of logger.calls.filter((c) => c.message.includes("retry"))) {
        const keys = Object.keys(call.data ?? {});
        expect(keys[0]).toBe("storyId");
        expect(call.data?.storyId).toBe(SAMPLE_STORY.id);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
