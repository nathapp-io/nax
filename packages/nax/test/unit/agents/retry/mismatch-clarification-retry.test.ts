import { describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import type { MismatchClarificationOpts, RetryContext, RetryDecision, RetryStrategy } from "@/agents/retry";
import { makeMismatchClarificationStrategy, makeParseRetryStrategy, ParseValidationError } from "@/agents/retry";
import type { TurnResult } from "@/agents/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const probe = new ParseValidationError("parse probe");
const transportError = new Error("transport failure");

type MismatchKind = "spec" | "quality";

/**
 * Reply text -> the mismatch kinds that reply carries. A reply absent from the map does not parse,
 * which is the shape-repair case; an empty kind list is a parseable, consistent reply.
 */
type KindsByReply = Record<string, readonly MismatchKind[]>;

function makeParse(byReply: KindsByReply): (output: string) => unknown {
  return (output) => (output in byReply ? { kinds: byReply[output] } : null);
}

function readKinds(parsed: unknown): readonly MismatchKind[] | null {
  if (typeof parsed !== "object" || parsed === null || !("kinds" in parsed)) return null;
  const { kinds } = parsed;
  return Array.isArray(kinds)
    ? kinds.filter((entry): entry is MismatchKind => entry === "spec" || entry === "quality")
    : null;
}

function makeCtx(lastOutput: string, overrides?: Partial<RetryContext>): RetryContext {
  return { site: "run", agentName: "claude", stage: "review", storyId: "US-012", lastOutput, ...overrides };
}

interface Inner {
  readonly strategy: RetryStrategy;
  /** Every `attempt` value the shape strategy received, in call order. */
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

/**
 * The real shape strategy as the inner, with the attempt arithmetic it receives recorded: a reply
 * that parses is accepted, one that does not gets the one repair `maxAttempts: 2` allows.
 */
function shapeLike(byReply: KindsByReply, exhaustedFallback?: (lastOutput: string) => unknown): Inner {
  const attempts: number[] = [];
  const shape = makeParseRetryStrategy({
    parse: makeParse(byReply),
    validate: (parsed) => parsed !== null,
    reviewerKind: "review",
    maxAttempts: 2,
    prompts: { invalid: () => "json repair", truncated: () => "json repair condensed" },
    ...(exhaustedFallback ? { exhaustedFallback } : {}),
  });
  return {
    attempts,
    strategy: {
      shouldRetry(failure, attempt, ctx) {
        attempts.push(attempt);
        return shape.shouldRetry(failure, attempt, ctx);
      },
    },
  };
}

interface BuildOverrides {
  readonly inner: RetryStrategy;
  readonly parse?: (output: string) => unknown;
  readonly promptCalls?: (readonly MismatchKind[])[];
  readonly logger?: MismatchClarificationOpts["_logger"];
}

function build(overrides: BuildOverrides): RetryStrategy {
  return makeMismatchClarificationStrategy<MismatchKind>({
    inner: overrides.inner,
    parse: overrides.parse ?? makeParse({}),
    mismatch: (parsed) => readKinds(parsed) ?? [],
    prompt: (kinds) => {
      overrides.promptCalls?.push(kinds);
      return `clarify ${kinds.join(",")}`;
    },
    reviewerKind: "review",
    _logger: overrides.logger,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("makeMismatchClarificationStrategy", () => {
  test("returns a strategy with a shouldRetry function", () => {
    const inner = recordingInner({ retry: false });
    expect(typeof build({ inner: inner.strategy }).shouldRetry).toBe("function");
  });

  describe("the shape retry comes first", () => {
    test("returns exactly the inner decision for an unparseable reply, with no clarification", () => {
      const innerDecision: RetryDecision = { retry: true, delayMs: 0, nextPrompt: "json repair" };
      const inner = recordingInner(innerDecision);
      const promptCalls: (readonly MismatchKind[])[] = [];
      const strategy = build({ inner: inner.strategy, parse: makeParse({ mismatch: ["spec"] }), promptCalls });

      expect(strategy.shouldRetry(probe, 0, makeCtx("not json"))).toBe(innerDecision);
      expect(promptCalls).toEqual([]);
    });

    test("returns exactly the inner decision for a transport error, an empty turn and an adapter failure", () => {
      const innerDecision: RetryDecision = { retry: false, fallback: "inner-fallback" };
      const inner = recordingInner(innerDecision);
      const promptCalls: (readonly MismatchKind[])[] = [];
      const strategy = build({ inner: inner.strategy, parse: makeParse({ mismatch: ["spec"] }), promptCalls });
      const turnWithFailure: TurnResult = {
        output: "mismatch",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        adapterFailure: { category: "availability", outcome: "fail-rate-limit", retriable: true, message: "" },
      };

      expect(strategy.shouldRetry(transportError, 0, makeCtx("mismatch"))).toBe(innerDecision);
      expect(strategy.shouldRetry(probe, 0, makeCtx(""))).toBe(innerDecision);
      expect(strategy.shouldRetry(probe, 0, makeCtx("mismatch", { lastTurnResult: turnWithFailure }))).toBe(
        innerDecision,
      );
      expect(promptCalls).toEqual([]);
    });

    test("a parseable consistent reply is accepted with no clarification", () => {
      const inner = recordingInner({ retry: false });
      const promptCalls: (readonly MismatchKind[])[] = [];
      const strategy = build({ inner: inner.strategy, parse: makeParse({ consistent: [] }), promptCalls });

      expect(strategy.shouldRetry(probe, 0, makeCtx("consistent"))).toEqual({ retry: false });
      expect(promptCalls).toEqual([]);
    });
  });

  describe("one clarification per invocation", () => {
    test("asks the reply's mismatch kinds once, through the prompt factory", () => {
      const inner = recordingInner({ retry: false });
      const promptCalls: (readonly MismatchKind[])[] = [];
      const strategy = build({ inner: inner.strategy, parse: makeParse({ both: ["spec", "quality"] }), promptCalls });

      expect(strategy.shouldRetry(probe, 0, makeCtx("both"))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: "clarify spec,quality",
      });
      expect(promptCalls).toEqual([["spec", "quality"]]);
    });

    test("never asks a second clarification, however inconsistent the following replies are", () => {
      const inner = recordingInner({ retry: false });
      const promptCalls: (readonly MismatchKind[])[] = [];
      const strategy = build({
        inner: inner.strategy,
        parse: makeParse({ one: ["spec"], two: ["spec", "quality"] }),
        promptCalls,
      });

      expect(strategy.shouldRetry(probe, 0, makeCtx("one"))).toMatchObject({ retry: true });
      expect(strategy.shouldRetry(probe, 1, makeCtx("two"))).toEqual({ retry: false });
      expect(promptCalls).toHaveLength(1);
    });
  });

  describe("the attempt arithmetic keeps both allowances", () => {
    test("subtracts the clarification it issued from the attempt the shape strategy sees", () => {
      const inner = shapeLike({ mismatch: ["spec"] });
      const strategy = build({ inner: inner.strategy, parse: makeParse({ mismatch: ["spec"] }) });

      expect(strategy.shouldRetry(probe, 0, makeCtx("mismatch"))).toMatchObject({ retry: true });
      expect(strategy.shouldRetry(probe, 1, makeCtx("not json"))).toEqual({
        retry: true,
        delayMs: 0,
        nextPrompt: "json repair",
      });
      // One clarification spent, so the shape strategy is back at its own attempt 0.
      expect(inner.attempts).toEqual([0, 0]);
    });

    test("adds the shape repairs already issued, so a hop restarted at 0 reissues none", () => {
      const inner = shapeLike({});
      const strategy = build({ inner: inner.strategy, parse: makeParse({}) });

      expect(strategy.shouldRetry(probe, 0, makeCtx("not json"))).toMatchObject({ retry: true });
      // A manager-owned fallback hop restarts the loop at attempt 0.
      expect(strategy.shouldRetry(probe, 0, makeCtx("not json"))).toEqual({ retry: false });
      expect(inner.attempts).toEqual([0, 1]);
    });
  });

  describe("exhaustion keeps the last parseable reply", () => {
    test("reports it as the fallback when the shape allowance runs out on an unparseable reply", () => {
      const inner = shapeLike({ "review-one": ["spec"] }, () => null);
      const strategy = build({ inner: inner.strategy, parse: makeParse({ "review-one": ["spec"] }) });

      strategy.shouldRetry(probe, 0, makeCtx("review-one"));
      expect(strategy.shouldRetry(probe, 1, makeCtx("not json"))).toMatchObject({ retry: true });
      const decision = strategy.shouldRetry(probe, 2, makeCtx("not json"));

      expect(decision).toEqual({ retry: false, fallback: { kinds: ["spec"] } });
    });

    test("leaves the inner fallback alone when it carries a value of its own", () => {
      const inner = shapeLike({ "review-one": ["spec"] }, () => "inner-verdict");
      const strategy = build({ inner: inner.strategy, parse: makeParse({ "review-one": ["spec"] }) });

      strategy.shouldRetry(probe, 0, makeCtx("review-one"));
      strategy.shouldRetry(probe, 1, makeCtx("not json"));
      expect(strategy.shouldRetry(probe, 2, makeCtx("not json"))).toEqual({ retry: false, fallback: "inner-verdict" });
    });
  });

  describe("the clarification log line", () => {
    test("logs one warn with storyId first, the kinds and the attempt", () => {
      const logger = makeLogger();
      const inner = recordingInner({ retry: false });
      const strategy = build({ inner: inner.strategy, parse: makeParse({ mismatch: ["spec"] }), logger });

      strategy.shouldRetry(probe, 0, makeCtx("mismatch"));

      expect(logger.calls).toHaveLength(1);
      const [call] = logger.calls;
      expect(call?.level).toBe("warn");
      expect(call?.message).toBe("Mismatch clarification");
      const data = call?.data ?? {};
      expect(Object.keys(data)[0]).toBe("storyId");
      expect(data).toMatchObject({ storyId: "US-012", kinds: "spec", attempt: 0 });
    });
  });
});
