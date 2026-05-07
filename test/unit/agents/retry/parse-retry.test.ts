import { describe, expect, test } from "bun:test";
import { makeParseRetryStrategy } from "../../../../src/agents/retry/parse-retry";
import { ParseValidationError } from "../../../../src/agents/retry/types";
import type { RetryContext } from "../../../../src/agents/retry/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<RetryContext>): RetryContext {
  return {
    site: "complete",
    agentName: "claude",
    stage: "review",
    storyId: "story-1",
    lastOutput: '{"valid": true}',
    ...overrides,
  };
}

const parseError = new ParseValidationError("parse failed");
const plainError = new Error("transport failure");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("makeParseRetryStrategy", () => {
  describe("AC-1: non-ParseValidationError falls through", () => {
    test("returns { retry: false } for plain Error", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
      });
      const result = strategy.shouldRetry(plainError, 0, makeCtx());
      expect(result).toEqual({ retry: false });
    });

    test("returns { retry: false } for AdapterFailure-shaped error", () => {
      const adapterErr = Object.assign(new Error("adapter"), { kind: "adapter-failure", retriable: false });
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
      });
      const result = strategy.shouldRetry(adapterErr, 0, makeCtx());
      expect(result).toEqual({ retry: false });
    });
  });

  describe("AC-2: ParseValidationError with empty/undefined lastOutput", () => {
    test("returns { retry: false } when lastOutput is undefined", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: undefined }));
      expect(result).toEqual({ retry: false });
    });

    test("returns { retry: false } when lastOutput is empty string", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "" }));
      expect(result).toEqual({ retry: false });
    });
  });

  describe("AC-3: ParseValidationError but validate returns true", () => {
    test("returns { retry: false } defensively when validate passes", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => true,
        reviewerKind: "test",
        parse: () => ({ parsed: true }),
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: '{"ok":true}' }));
      expect(result).toEqual({ retry: false });
    });
  });

  describe("AC-4: truncated output picks truncated prompt", () => {
    test("returns retry=true with truncated prompt when output looks truncated", () => {
      const longOutput = "x".repeat(200_000); // well over MAX_AGENT_OUTPUT_CHARS - 100
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        looksTruncated: () => true,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: longOutput }));
      expect(result).toEqual({ retry: true, delayMs: 0, nextPrompt: "truncated-prompt" });
    });
  });

  describe("AC-5: non-truncated output picks invalid prompt", () => {
    test("returns retry=true with invalid prompt when output does not look truncated", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: '{"bad": true}' }));
      expect(result).toEqual({ retry: true, delayMs: 0, nextPrompt: "invalid-prompt" });
    });
  });

  describe("AC-6: parse throws or returns null → treated as invalid", () => {
    test("returns retry=true when parse throws", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => { throw new Error("parse error"); },
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "not json" }));
      expect(result).toEqual({ retry: true, delayMs: 0, nextPrompt: "invalid-prompt" });
    });

    test("returns retry=true when parse returns null", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "null-output" }));
      expect(result).toEqual({ retry: true, delayMs: 0, nextPrompt: "invalid-prompt" });
    });
  });

  describe("AC-7: budget exhausted", () => {
    test("returns { retry: false } when attempt >= maxAttempts - 1 (default maxAttempts=2)", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
      });
      // attempt 1 >= 2-1=1 → exhausted
      const result = strategy.shouldRetry(parseError, 1, makeCtx({ lastOutput: "something" }));
      expect(result).toEqual({ retry: false });
    });

    test("allows retry when attempt < maxAttempts - 1 (default)", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
      });
      // attempt 0 < 2-1=1 → not exhausted
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "something" }));
      expect(result.retry).toBe(true);
    });

    test("respects custom maxAttempts", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        maxAttempts: 4,
        parse: () => null,
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
      });
      // attempt 3 >= 4-1=3 → exhausted
      expect(strategy.shouldRetry(parseError, 3, makeCtx({ lastOutput: "x" }))).toEqual({ retry: false });
      // attempt 2 < 4-1=3 → allowed
      expect(strategy.shouldRetry(parseError, 2, makeCtx({ lastOutput: "x" })).retry).toBe(true);
    });
  });

  describe("AC-8: defaults to tryParseLLMJson when parse omitted", () => {
    test("parses valid JSON and calls validate with it", () => {
      let capturedParsed: unknown;
      const strategy = makeParseRetryStrategy({
        validate: (v: unknown) => { capturedParsed = v; return true; },
        reviewerKind: "test",
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
        // parse omitted — should default to tryParseLLMJson
      });
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: '{"key":"val"}' }));
      // validate returned true → { retry: false }
      expect(result).toEqual({ retry: false });
      expect(capturedParsed).toEqual({ key: "val" });
    });
  });

  describe("AC-9: defaults to looksLikeTruncatedJson when looksTruncated omitted", () => {
    test("does not throw when looksTruncated is omitted", () => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
        // looksTruncated omitted — should default to looksLikeTruncatedJson
      });
      // short output → not truncated → invalid prompt
      const result = strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput: "short" }));
      expect(result).toEqual({ retry: true, delayMs: 0, nextPrompt: "invalid-prompt" });
    });
  });

  describe("AC-10: warn log has storyId as first key", () => {
    test("emits warn with storyId as first key in data", () => {
      const warnCalls: Array<[string, string, Record<string, unknown>]> = [];
      const mockLogger = {
        warn(kind: string, msg: string, data: Record<string, unknown>) {
          warnCalls.push([kind, msg, data]);
        },
      };

      // We'll pass a custom logger via the module-level getSafeLogger mock
      // by using a custom `_deps` pattern — but since parse-retry uses getSafeLogger,
      // we test that storyId is first in the data object by inspecting logged args.
      // We use the injectable _deps pattern if available, or verify through side effects.

      // The strategy should log on parse failure — use a spy via module injection
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "semantic",
        parse: () => null,
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
        _logger: mockLogger,
      } as Parameters<typeof makeParseRetryStrategy>[0]);

      strategy.shouldRetry(parseError, 0, makeCtx({ storyId: "story-abc", lastOutput: "bad" }));

      expect(warnCalls).toHaveLength(1);
      const [, , data] = warnCalls[0]!;
      const keys = Object.keys(data);
      expect(keys[0]).toBe("storyId");
      expect(data.storyId).toBe("story-abc");
    });
  });

  describe("AC-11: exported from index", () => {
    test("makeParseRetryStrategy is exported from src/agents/retry/index.ts", async () => {
      const mod = await import("../../../../src/agents/retry");
      expect(typeof mod.makeParseRetryStrategy).toBe("function");
    });
  });
});
