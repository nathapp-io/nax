import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeParseRetryStrategy } from "@/agents/retry/parse-retry";
import { ParseValidationError } from "@/agents/retry/types";
import type { RetryContext } from "@/agents/retry/types";

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
    test.each([
      ["plain Error", plainError],
      [
        "AdapterFailure-shaped error",
        Object.assign(new Error("adapter"), { kind: "adapter-failure", retriable: false }),
      ],
    ])("returns { retry: false } for %s", (_label, err) => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
      });
      expect(strategy.shouldRetry(err, 0, makeCtx())).toEqual({ retry: false });
    });
  });

  describe("AC-2: ParseValidationError with empty/undefined lastOutput", () => {
    test.each([
      ["undefined", undefined as unknown as string],
      ["empty string", ""],
    ])("returns { retry: false } when lastOutput is %s", (_label, lastOutput) => {
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        prompts: { invalid: () => "invalid", truncated: () => "truncated" },
      });
      expect(strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput }))).toEqual({ retry: false });
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
        parse: () => {
          throw new Error("parse error");
        },
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
        validate: (v: unknown) => {
          capturedParsed = v;
          return true;
        },
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

  describe("AC-10b: outputPreview surfaces unparseable content", () => {
    function captureWarn(opts: Partial<Parameters<typeof makeParseRetryStrategy>[0]>, lastOutput: string) {
      const warnCalls: Array<[string, string, Record<string, unknown>]> = [];
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "verifier",
        parse: () => null,
        looksTruncated: () => false,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
        _logger: { warn: (k, m, d) => warnCalls.push([k, m, d]) },
        ...opts,
      } as Parameters<typeof makeParseRetryStrategy>[0]);
      strategy.shouldRetry(parseError, 0, makeCtx({ lastOutput }));
      return warnCalls[0]![2];
    }

    test("includes whitespace-collapsed outputPreview when outputPreviewBytes is set", () => {
      const data = captureWarn({ outputPreviewBytes: 600 }, "  not a\n\n verdict  ");
      expect(data.outputPreview).toBe("not a verdict");
      expect(data.originalByteSize).toBe("  not a\n\n verdict  ".length);
    });

    test("clips preview to outputPreviewBytes with an ellipsis", () => {
      const data = captureWarn({ outputPreviewBytes: 10 }, "x".repeat(50));
      expect(data.outputPreview).toBe(`${"x".repeat(10)}…`);
    });

    test("omits outputPreview when outputPreviewBytes is unset", () => {
      const data = captureWarn({}, "some bad output");
      expect(data).not.toHaveProperty("outputPreview");
    });
  });

  describe("AC-13: pre-classified adapterFailure on a non-empty turn skips the reformat retry (BUG-62)", () => {
    test("returns { retry: false, fallback } immediately (no reformat attempt) when lastTurnResult.adapterFailure is set", () => {
      let exhaustedFallbackCalls = 0;
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
        exhaustedFallback: (lastOutput) => {
          exhaustedFallbackCalls++;
          return { passed: false, failOpen: true, unparsedPreview: lastOutput };
        },
      });
      const result = strategy.shouldRetry(
        parseError,
        0,
        makeCtx({
          lastOutput: "Selected model is at capacity. Please try a different model.",
          lastTurnResult: {
            output: "Selected model is at capacity. Please try a different model.",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 0,
            adapterFailure: { category: "availability", outcome: "fail-rate-limit", retriable: true, message: "" },
          },
        }),
      );
      // The escape hatch still fires — a strict-parser op with no op.recover
      // must not fall through to a raw-TurnResult passthrough (retry-strategy.md
      // "Strict-parser interaction"). What's saved is the wasted reformat turn
      // (attempt stays at 0, no nextPrompt sent), not the fallback call itself.
      expect(result).toEqual({
        retry: false,
        fallback: {
          passed: false,
          failOpen: true,
          unparsedPreview: "Selected model is at capacity. Please try a different model.",
        },
      });
      expect(exhaustedFallbackCalls).toBe(1);
    });

    test("skips straight to fallback on attempt 0 — does not wait for maxAttempts to exhaust first", () => {
      let sawAttempt: number | undefined;
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        maxAttempts: 5,
        parse: () => null,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
        exhaustedFallback: () => {
          sawAttempt = 0;
          return { passed: false };
        },
      });
      strategy.shouldRetry(
        parseError,
        0,
        makeCtx({
          lastOutput: "Selected model is at capacity.",
          lastTurnResult: {
            output: "Selected model is at capacity.",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 0,
            adapterFailure: { category: "availability", outcome: "fail-rate-limit", retriable: true, message: "" },
          },
        }),
      );
      expect(sawAttempt).toBe(0);
    });

    test("empty-output exhaustedFallback path is unaffected — still fires when lastOutput is empty", () => {
      let exhaustedFallbackCalled = false;
      const strategy = makeParseRetryStrategy({
        validate: () => false,
        reviewerKind: "test",
        parse: () => null,
        prompts: { invalid: () => "invalid-prompt", truncated: () => "truncated-prompt" },
        exhaustedFallback: () => {
          exhaustedFallbackCalled = true;
          return { passed: false };
        },
      });
      const result = strategy.shouldRetry(
        parseError,
        0,
        makeCtx({
          lastOutput: "",
          lastTurnResult: {
            output: "",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 0,
            adapterFailure: { category: "availability", outcome: "fail-stale", retriable: true, message: "" },
          },
        }),
      );
      expect(result).toEqual({ retry: false, fallback: { passed: false } });
      expect(exhaustedFallbackCalled).toBe(true);
    });
  });

  describe("AC-11: exported from index", () => {
    test("makeParseRetryStrategy is exported from src/agents/retry/index.ts", async () => {
      const mod = await import("@/agents/retry");
      expect(typeof mod.makeParseRetryStrategy).toBe("function");
    });
  });

  // AC-12: Documentation example correctness
  // Bug found by adversarial review: retry-strategy.md:118 uses `parser:` (wrong),
  // `nextPrompt:` (wrong), and omits required `validate:` and `reviewerKind:` fields.
  // These tests assert the spec-correct API surface in the documentation example.
  describe("AC-12: retry-strategy.md example uses correct makeParseRetryStrategy API", () => {
    const ruleFilePath = join(__dirname, "../../../../.claude/rules/retry-strategy.md");

    async function extractMakeParseRetryExample(): Promise<string> {
      const content = await Bun.file(ruleFilePath).text();
      const startMarker = "makeParseRetryStrategy({";
      const start = content.indexOf(startMarker);
      if (start === -1) throw new Error("makeParseRetryStrategy example not found in retry-strategy.md");
      // Find closing }) that ends the outer call
      const end = content.indexOf("}),", start);
      if (end === -1) throw new Error("Could not find end of makeParseRetryStrategy example");
      return content.slice(start, end + 3);
    }

    test("example uses correct API surface (parse/prompts/validate/reviewerKind, not parser/nextPrompt)", async () => {
      const block = await extractMakeParseRetryExample();
      expect(block).not.toContain("parser:");
      expect(block).toContain("parse:");
      expect(block).not.toContain("nextPrompt:");
      expect(block).toContain("prompts:");
      expect(block).toContain("validate:");
      expect(block).toContain("reviewerKind:");
    });
  });
});
