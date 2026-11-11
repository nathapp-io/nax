import { describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import type { CoverageRetryOpts, RetryContext, RetryDecision, RetryStrategy } from "@/agents/retry";
import { makeCoverageRetryStrategy, ParseValidationError } from "@/agents/retry";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const parseError = new ParseValidationError("parse failed");
const transportError = new Error("transport failure");

/**
 * Reply text → the required files that reply leaves unread. A reply absent from
 * the map does not parse (`parse` returns null), which is also the unparseable case.
 */
type UnreadByReply = Record<string, readonly string[]>;

/** Read `unread` off a parsed reply without a cast; null when the shape is wrong. */
function readUnread(parsed: unknown): readonly string[] | null {
  if (typeof parsed !== "object" || parsed === null || !("unread" in parsed)) {
    return null;
  }
  const { unread } = parsed;
  return Array.isArray(unread) ? unread.filter((entry): entry is string => typeof entry === "string") : null;
}

function makeParse(byReply: UnreadByReply): (output: string) => unknown {
  return (output) => {
    const unread = byReply[output];
    return unread ? { unread } : null;
  };
}

const missing = (parsed: unknown): readonly string[] => readUnread(parsed) ?? [];

const prompt = (files: readonly string[], progress: { attempt: number; max: number }): string =>
  `coverage ${progress.attempt}/${progress.max}: ${files.join(", ")}`;

const exhaustedFallback = (lastOutput: string): unknown => ({ exhausted: true, lastOutput });

function makeCtx(overrides?: Partial<RetryContext>): RetryContext {
  return {
    site: "complete",
    agentName: "claude",
    stage: "review",
    storyId: "US-001",
    lastOutput: "reply-one",
    ...overrides,
  };
}

interface Inner {
  readonly strategy: RetryStrategy;
  /** Every `attempt` value the inner strategy received, in call order. */
  readonly attempts: number[];
}

function recordingInner(decision: RetryDecision | ((attempt: number) => RetryDecision)): Inner {
  const attempts: number[] = [];
  return {
    attempts,
    strategy: {
      shouldRetry(_failure, attempt) {
        attempts.push(attempt);
        return typeof decision === "function" ? decision(attempt) : decision;
      },
    },
  };
}

interface BuildOverrides {
  readonly inner: RetryStrategy;
  readonly parse?: (output: string) => unknown;
  readonly missing?: (parsed: unknown) => readonly string[];
  readonly maxCoverageRetries?: number;
  readonly prompt?: (files: readonly string[], progress: { attempt: number; max: number }) => string;
  readonly logger?: CoverageRetryOpts["_logger"];
  /** Counts `prompt` invocations, so a test can assert no coverage retry was sent. */
  readonly promptCalls?: number[];
}

function build(overrides: BuildOverrides): RetryStrategy {
  return makeCoverageRetryStrategy({
    inner: overrides.inner,
    parse: overrides.parse ?? makeParse({}),
    missing: overrides.missing ?? missing,
    maxCoverageRetries: overrides.maxCoverageRetries ?? 3,
    prompt: (files, progress) => {
      overrides.promptCalls?.push(progress.attempt);
      return (overrides.prompt ?? prompt)(files, progress);
    },
    exhaustedFallback,
    reviewerKind: "review",
    _logger: overrides.logger,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("makeCoverageRetryStrategy", () => {
  describe("AC-1: exported from the retry barrel", () => {
    test("returns an object with a shouldRetry function", () => {
      const inner = recordingInner({ retry: false });
      const strategy = makeCoverageRetryStrategy({
        inner: inner.strategy,
        parse: makeParse({}),
        missing,
        maxCoverageRetries: 3,
        prompt,
        exhaustedFallback,
        reviewerKind: "review",
      });
      expect(typeof strategy.shouldRetry).toBe("function");
    });
  });

  describe("AC-2 to AC-4: the wrapper defers to the inner decision", () => {
    test.each([
      ["a plain Error", transportError, "reply-one"],
      ["an AdapterFailure-shaped error", Object.assign(new Error("adapter"), { retriable: true }), "reply-one"],
    ])("AC-2 returns exactly the inner decision for %s", (_label, failure, lastOutput) => {
      const innerDecision: RetryDecision = { retry: false, fallback: "inner-fallback" };
      const inner = recordingInner(innerDecision);
      const strategy = build({ inner: inner.strategy, parse: makeParse({ "reply-one": ["a.ts"] }) });
      expect(strategy.shouldRetry(failure, 0, makeCtx({ lastOutput }))).toBe(innerDecision);
    });

    test.each([
      ["an empty string", ""],
      ["undefined", undefined],
    ])("AC-3 returns exactly the inner decision when lastOutput is %s", (_label, lastOutput) => {
      const innerDecision: RetryDecision = { retry: false, fallback: "inner-fallback" };
      const inner = recordingInner(innerDecision);
      const strategy = build({ inner: inner.strategy, parse: makeParse({ "reply-one": ["a.ts"] }) });
      expect(strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput }))).toBe(innerDecision);
    });

    test("AC-4 returns exactly the inner decision when the turn carries an adapterFailure", () => {
      const innerDecision: RetryDecision = { retry: false, fallback: "inner-fallback" };
      const inner = recordingInner(innerDecision);
      const strategy = build({ inner: inner.strategy, parse: makeParse({ "reply-one": ["a.ts"] }) });
      const result = strategy.shouldRetry(
        parseError,
        0,
        makeCtx({
          lastOutput: "reply-one",
          lastTurnResult: {
            output: "reply-one",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 0,
            adapterFailure: {
              category: "availability",
              outcome: "fail-rate-limit",
              retriable: true,
              message: "",
            },
          },
        }),
      );
      expect(result).toBe(innerDecision);
    });

    test("AC-5 returns the inner decision when the reply does not parse", () => {
      const innerDecision: RetryDecision = { retry: false };
      const inner = recordingInner(innerDecision);
      const strategy = build({
        inner: inner.strategy,
        parse: () => null,
        missing: () => ["a.ts", "b.ts"],
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx())).toBe(innerDecision);
    });
  });

  describe("AC-6 to AC-7: shape and triage retries come first", () => {
    test("AC-6 returns the inner retry decision, not a coverage retry", () => {
      const innerDecision: RetryDecision = { retry: true, delayMs: 0, nextPrompt: "triage" };
      const inner = recordingInner(innerDecision);
      const promptCalls: number[] = [];
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": ["a.ts", "b.ts"] }),
        promptCalls,
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx())).toBe(innerDecision);
      expect(promptCalls).toEqual([]);
    });

    test("AC-7 returns the inner decision for a reply that misses no file", () => {
      const innerDecision: RetryDecision = { retry: false };
      const inner = recordingInner(innerDecision);
      const promptCalls: number[] = [];
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": [] }),
        promptCalls,
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx())).toBe(innerDecision);
      expect(promptCalls).toEqual([]);
    });
  });

  describe("AC-8 to AC-9: a coverage retry re-prompts with the missing files", () => {
    test("AC-8 sends the first coverage retry with attempt 1 of max 3", () => {
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": ["a.ts", "b.ts"] }),
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx())).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: prompt(["a.ts", "b.ts"], { attempt: 1, max: 3 }),
      });
    });

    test("AC-9 the second coverage retry names only what is still unread, at attempt 2 of 3", () => {
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({
          "reply-one": ["a.ts", "b.ts"],
          "reply-two": ["b.ts"],
        }),
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: prompt(["a.ts", "b.ts"], { attempt: 1, max: 3 }),
      });
      expect(strategy.shouldRetry(parseError, 1, makeCtx({ lastOutput: "reply-two" }))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: prompt(["b.ts"], { attempt: 2, max: 3 }),
      });
    });
  });

  describe("AC-10 to AC-12: the coverage budget stops the retries", () => {
    test("AC-10 stops with the fallback when a retry covered no more files", () => {
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({
          "reply-one": ["a.ts", "b.ts"],
          "reply-two": ["a.ts", "b.ts"],
        }),
      });
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }));
      expect(strategy.shouldRetry(parseError, 1, makeCtx({ lastOutput: "reply-two" }))).toEqual({
        retry: false,
        fallback: exhaustedFallback("reply-two"),
      });
    });

    test("AC-11 stops with the fallback once three coverage retries are spent", () => {
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({
          "reply-one": ["a.ts", "b.ts", "c.ts"],
          "reply-two": ["b.ts", "c.ts"],
          "reply-three": ["c.ts"],
          "reply-four": ["c.ts"],
        }),
      });
      for (const [attempt, reply] of ["reply-one", "reply-two", "reply-three"].entries()) {
        expect(strategy.shouldRetry(parseError, attempt, makeCtx({ lastOutput: reply }))).toMatchObject({
          retry: true,
        });
      }
      expect(strategy.shouldRetry(parseError, 3, makeCtx({ lastOutput: "reply-four" }))).toEqual({
        retry: false,
        fallback: exhaustedFallback("reply-four"),
      });
    });

    test("AC-12 sends no coverage retry when maxCoverageRetries is 0", () => {
      const inner = recordingInner({ retry: false });
      const promptCalls: number[] = [];
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": ["a.ts"] }),
        maxCoverageRetries: 0,
        promptCalls,
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx())).toEqual({
        retry: false,
        fallback: exhaustedFallback("reply-one"),
      });
      expect(promptCalls).toEqual([]);
    });
  });

  describe("AC-13 and AC-19: coverage retries do not spend the inner budget", () => {
    test("AC-13 passes attempt 0 to the inner strategy when attempt is 2 after two coverage retries", () => {
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({
          "reply-one": ["a.ts", "b.ts"],
          "reply-two": ["b.ts"],
        }),
      });
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }));
      strategy.shouldRetry(parseError, 1, makeCtx({ lastOutput: "reply-two" }));
      strategy.shouldRetry(parseError, 2, makeCtx({ lastOutput: "unparseable reply" }));
      expect(inner.attempts).toEqual([0, 0, 0]);
    });

    test("AC-19 passes attempt 0 to the inner strategy when a hop re-run resets attempt", () => {
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({
          "reply-one": ["a.ts", "b.ts"],
          "reply-two": ["b.ts"],
          "reply-three": [],
        }),
      });
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }));
      strategy.shouldRetry(parseError, 1, makeCtx({ lastOutput: "reply-two" }));
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-three" }));
      expect(inner.attempts).toEqual([0, 0, 0]);
    });
  });

  describe("AC-14 to AC-17: the strategy's own log lines", () => {
    test("AC-14 logs one 'Coverage retry' warn with storyId first, unread, attempt and max", () => {
      const logger = makeLogger();
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": ["a.ts", "b.ts"] }),
        logger,
      });
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }));
      expect(logger.calls).toHaveLength(1);
      const [call] = logger.calls;
      expect(call?.level).toBe("warn");
      expect(call?.stage).toBe("review");
      expect(call?.message).toBe("Coverage retry");
      const data = call?.data ?? {};
      expect(Object.keys(data)[0]).toBe("storyId");
      expect(data).toMatchObject({ storyId: "US-001", unread: 2, attempt: 1, max: 3 });
    });

    test("AC-15 logs 'Coverage retry stopped' with reason 'budget'", () => {
      const logger = makeLogger();
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": ["a.ts"] }),
        maxCoverageRetries: 0,
        logger,
      });
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }));
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0]?.message).toBe("Coverage retry stopped");
      expect(logger.calls[0]?.data).toMatchObject({ storyId: "US-001", unread: 1, attempt: 0, reason: "budget" });
    });

    test("AC-16 logs 'Coverage retry stopped' with reason 'no progress'", () => {
      const logger = makeLogger();
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({
          "reply-one": ["a.ts", "b.ts"],
          "reply-two": ["a.ts", "b.ts"],
        }),
        logger,
      });
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }));
      strategy.shouldRetry(parseError, 1, makeCtx({ lastOutput: "reply-two" }));
      const stopped = logger.calls.filter((call) => call.message === "Coverage retry stopped");
      expect(stopped).toHaveLength(1);
      expect(stopped[0]?.data).toMatchObject({ storyId: "US-001", unread: 2, attempt: 1, reason: "no progress" });
    });

    test("AC-17 a coverage retry never logs a 'JSON parse retry' message", () => {
      const logger = makeLogger();
      const inner = recordingInner({ retry: false });
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": ["a.ts"] }),
        logger,
      });
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "reply-one" }));
      expect(logger.calls.map((call) => call.message)).toEqual(["Coverage retry"]);
      expect(logger.calls.every((call) => !call.message.includes("JSON parse retry"))).toBe(true);
    });
  });

  describe("AC-18: coverage never retries past an exhausted inner", () => {
    test("returns the inner fallback decision and sends no coverage retry", () => {
      const innerDecision: RetryDecision = { retry: false, fallback: "triage-exhausted" };
      const inner = recordingInner(innerDecision);
      const promptCalls: number[] = [];
      const logger = makeLogger();
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ "reply-one": ["a.ts"] }),
        promptCalls,
        logger,
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx())).toBe(innerDecision);
      expect(promptCalls).toEqual([]);
      expect(logger.calls).toEqual([]);
    });
  });
});
