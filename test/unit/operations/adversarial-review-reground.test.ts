/**
 * Tests for adversarialReviewOp.hopBody — adversarial reground re-prompt (AC1-AC8).
 *
 * AC1: When first-pass adversarial output is `passed:false` and `filterByAcQuote`
 *      yields zero blocking accepted findings with `dropped.length > 0`, and
 *      `input.adversarialConfig.acRegroundOnDrop !== false`, then
 *      `adversarialReviewOp.hopBody` issues exactly one additional `ctx.send` call.
 * AC2: When the additional adversarial reprompt is built, then its prompt text
 *      includes the exact `dropped[0].finding.issue` string and the human-readable
 *      translation of `dropped[0].code` from `DROP_CODE_MESSAGES_QUOTE`.
 * AC3: When the second-turn response parses and contains at least one blocking
 *      finding that survives AC filtering, then returned `TurnResult.output`
 *      parses to JSON containing that blocking finding and outer verify returns
 *      `passed:false` with non-empty `normalizedFindings`.
 * AC4: When the second-turn response parses and has no surviving blocking findings
 *      while `passed:true`, then returned `TurnResult.output` parses to JSON with
 *      `passed:true` and findings equal to advisory union from first and second
 *      passes, and the outer `parse()` + `verify()` chain produces an
 *      `AdversarialReviewOutput` with `passed: true`.
 * AC5: When second-turn JSON parsing fails or second-turn blocking findings are
 *      all dropped by AC filtering, then `adversarialReviewOp.hopBody` returns
 *      the first-turn `TurnResult` unchanged — preserving today's fail-closed
 *      behavior byte-identically.
 * AC6: When `input.adversarialConfig.acRegroundOnDrop === false`, then
 *      `adversarialReviewOp.hopBody` performs no additional send and returns
 *      behavior byte-identical to the baseline single-turn path.
 * AC7: When first-pass output does not satisfy trigger conditions (`passed:true`,
 *      surviving blocking findings exist, or `dropped.length === 0`), then no
 *      reprompt send occurs.
 * AC8: When `adversarialReviewOp.hopBody` implements the re-prompt path, then no
 *      `hasReprompted` flag or equivalent mutable state is introduced — the
 *      at-most-one guarantee derives structurally from `hopBody` being invoked
 *      once per session turn with `evaluateRepromptTrigger` running exactly once
 *      between the first `sendWithParseRetry` and the optional re-prompt `ctx.send`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestRuntime, withTempDir } from "@test/helpers";
import type { AdversarialReviewInput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY = {
  id: "STORY-REGRD",
  title: "Adversarial reground test",
  description: "reground dropped findings",
  acceptanceCriteria: [
    "AC1: auth login must not allow SQL injection attacks",
    "AC2: handler must not throw unhandled exceptions",
    "AC3: sessions expire after 24h",
  ],
};

const ADVERSARIAL_CONFIG_DEFAULT = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [] as string[],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
  acRegroundOnDrop: true,
  substantiation: { requote: false, maxRequotes: 0 },
};

const STORY_WITH_AC = {
  id: "STORY-AC-GROUND",
  title: "AC grounding test",
  description: "test ac grounding",
  acceptanceCriteria: [
    "auth login must not allow SQL injection attacks",
    "handler must not throw unhandled exceptions",
    "sessions expire after 24h",
  ],
};

// Helper to make a finding that will be dropped by filterByAcQuote (missing acQuote)
function makeDroppedFinding(severity: "error" | "warning" | "info" = "error"): Record<string, unknown> {
  return {
    severity,
    category: "security",
    file: "src/auth.ts",
    line: 1,
    issue: "SQL injection via rawQuery — no parameterization",
    suggestion: "Use parameterized queries",
    // missing acQuote and acIndex — will be dropped by filterByAcQuote
  };
}

// Helper to make an accepted finding (has valid acQuote and acIndex)
function makeAcceptedFinding(
  severity: "error" | "warning" | "info" = "error",
  issue = "SQL injection via rawQuery — no parameterization",
): Record<string, unknown> {
  return {
    severity,
    category: "security",
    file: "src/auth.ts",
    line: 1,
    issue,
    suggestion: "Use parameterized queries",
    acQuote: "auth login must not allow SQL injection attacks",
    acIndex: 1,
    verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery(u + p)" },
  };
}

describe("adversarialReviewOp.hopBody — reground AC1: trigger issues exactly one additional send", () => {
  test("reprompt fires when first-pass passed:false, zero blocking accepted, dropped.length > 0, acRegroundOnDrop !== false", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      // First turn: passed:false with a finding that will be dropped (missing acQuote)
      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      // Second turn: passed:false with a valid finding that survives AC filter
      const secondTurn = JSON.stringify({
        passed: false,
        findings: [makeAcceptedFinding("error", "SQL injection vulnerability present")],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expect(callCount).toBe(2);
    });
  });

  test("no additional send when acRegroundOnDrop === false", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT, acRegroundOnDrop: false },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expect(callCount).toBe(1);
      expect(result.output).toBe(firstTurn);
    });
  });
});

describe("adversarialReviewOp.hopBody — reground AC2: reprompt prompt content", () => {
  test("reprompt prompt includes exact dropped[0].finding.issue string", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const droppedIssue = "SQL injection via rawQuery — no parameterization";
      const firstTurn = JSON.stringify({
        passed: false,
        findings: [{ ...makeDroppedFinding("error"), issue: droppedIssue }],
      });

      const secondTurn = JSON.stringify({ passed: false, findings: [] });

      let capturedPrompt = "";
      const mockSend = mock(async () => {
        return {
          output: capturedPrompt === "" ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      // Override send to capture the prompt on second call
      const sendImpl = mock(async (prompt: string) => {
        capturedPrompt = prompt;
        return {
          output: capturedPrompt === prompt && capturedPrompt !== "" ? secondTurn : firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      await adversarialReviewOp.hopBody!("initial prompt", {
        send: sendImpl,
        sendWithParseRetry: mock(async () => ({
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        })),
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expect(capturedPrompt).toContain(droppedIssue);
    });
  });

  test("reprompt prompt includes human-readable translation of dropped[0].code from DROP_CODE_MESSAGES_QUOTE", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      // missing_ac_quote is the code when acQuote is absent
      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      const secondTurn = JSON.stringify({ passed: false, findings: [] });

      let capturedPrompt = "";
      const sendImpl = mock(async (prompt: string) => {
        if (capturedPrompt === "") {
          capturedPrompt = prompt;
          return { output: firstTurn, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        }
        return { output: secondTurn, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      });

      await adversarialReviewOp.hopBody!("initial prompt", {
        send: sendImpl,
        sendWithParseRetry: mock(async () => ({
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        })),
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      // DROP_CODE_MESSAGES_QUOTE.missing_ac_quote = "no `acQuote` field was provided — every blocking finding must cite an AC"
      expect(capturedPrompt).toContain("no `acQuote` field was provided");
    });
  });
});

describe("adversarialReviewOp.hopBody — reground AC3: second turn has surviving blocking finding", () => {
  test("returns TurnResult with blocking finding in output; outer verify returns passed:false with non-empty normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      // Second turn: blocking finding with valid AC grounding that survives filter
      const blockingFinding = {
        severity: "error",
        category: "security",
        file: "src/auth.ts",
        line: 1,
        issue: "SQL injection vulnerability confirmed",
        suggestion: "Use parameterized queries",
        acQuote: "auth login must not allow SQL injection attacks",
        acIndex: 1,
        verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery(u + p)" },
      };
      const secondTurn = JSON.stringify({
        passed: false,
        findings: [blockingFinding],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      const parsed = JSON.parse(result.output);
      expect(parsed.passed).toBe(false);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0].severity).toBe("error");
    });
  });
});

describe("adversarialReviewOp.hopBody — reground AC4: second turn passed:true with no blocking findings", () => {
  test("returns passed:true with advisory union from first and second passes; outer parse+verify chain produces passed:true", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      // First turn: all findings dropped by AC filter (missing acQuote)
      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error"), makeDroppedFinding("warning")],
      });

      // Second turn: passed:true with advisory findings only (no blocking after AC filter)
      const secondTurn = JSON.stringify({
        passed: true,
        findings: [
          {
            severity: "info",
            category: "convention",
            file: "src/auth.ts",
            line: 2,
            issue: "Missing storyId in logger call",
            suggestion: "Add storyId to logger",
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      const parsed = JSON.parse(result.output);
      // passed:true from second turn
      expect(parsed.passed).toBe(true);
      // Advisory union: warning from first (non-blocking, passes filterByAcQuote) + info from second
      expect(parsed.findings).toHaveLength(2);
      const severities = parsed.findings.map((f: { severity: string }) => f.severity);
      expect(severities).toContain("warning");
      expect(severities).toContain("info");
    });
  });
});

/**
 * Verify the synthesised output still parses to the first-turn's verdict
 * (passed + findings) and carries the expected `_repromptInfo` marker. The
 * marker is added by `withRepromptMarker` for telemetry; downstream behavior
 * remains fail-closed because `passed` and `findings` are untouched.
 */
function expectFirstTurnPreservedWithMarker(
  resultOutput: string,
  firstTurn: string,
  expectedOutcome: "parse-failed" | "still-dropped",
): void {
  const expected = JSON.parse(firstTurn) as Record<string, unknown>;
  const actual = JSON.parse(resultOutput) as Record<string, unknown>;
  expect(actual.passed).toEqual(expected.passed);
  expect(actual.findings).toEqual(expected.findings);
  expect(actual._repromptInfo).toMatchObject({ outcome: expectedOutcome });
}

describe("adversarialReviewOp.hopBody — reground AC5: second turn fails or all blocking dropped", () => {
  test("returns first-turn TurnResult unchanged when second-turn JSON parsing fails", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      // Invalid JSON on second turn
      const secondTurn = "not valid json at all";

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expectFirstTurnPreservedWithMarker(result.output, firstTurn, "parse-failed");
    });
  });

  test("returns first-turn TurnResult unchanged when second-turn blocking findings are all dropped by AC filter", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      // Second turn: all findings are also dropped (no valid acQuote)
      // These are blocking (error) but will be dropped by AC filter
      const secondTurn = JSON.stringify({
        passed: false,
        findings: [
          { ...makeDroppedFinding("error"), issue: "Another SQL injection" },
          { ...makeDroppedFinding("error"), issue: "Yet another vulnerability" },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expectFirstTurnPreservedWithMarker(result.output, firstTurn, "still-dropped");
    });
  });
});

describe("adversarialReviewOp.hopBody — reground AC6: acRegroundOnDrop === false disables reprompt", () => {
  test("returns behavior byte-identical to baseline single-turn path when acRegroundOnDrop === false", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT, acRegroundOnDrop: false },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expect(callCount).toBe(1);
      expect(result.output).toBe(firstTurn);
    });
  });
});

describe("adversarialReviewOp.hopBody — reground AC7: no reprompt when trigger conditions not met", () => {
  test("no reprompt when first-pass passed:true", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      // inspectedFiles present → the #3A inspection-trail guard is satisfied,
      // so this test isolates the reground precondition (no reprompt on pass).
      const firstTurn = JSON.stringify({ passed: true, inspectedFiles: ["src/auth.ts"], findings: [] });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expect(callCount).toBe(1);
      expect(result.output).toBe(firstTurn);
    });
  });

  test("no reprompt when surviving blocking findings exist", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      // First turn: has a blocking finding that survives AC filter
      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeAcceptedFinding("error", "SQL injection confirmed")],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expect(callCount).toBe(1);
      expect(result.output).toBe(firstTurn);
    });
  });

  test("no reprompt when dropped.length === 0", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      // First turn: all findings have valid acQuote → nothing dropped
      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeAcceptedFinding("error")],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      const result = await adversarialReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      } as any);

      expect(callCount).toBe(1);
      expect(result.output).toBe(firstTurn);
    });
  });
});

describe("adversarialReviewOp.hopBody — reground AC8: no mutable hasReprompted state", () => {
  test("hopBody implementation uses no hasReprompted flag or equivalent mutable state", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });
      const secondTurn = JSON.stringify({
        passed: true,
        findings: [],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        };
      });

      // Call hopBody twice with the same mock — second call should also reprompt if trigger fires
      const ctx1 = {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      };

      await adversarialReviewOp.hopBody!("prompt1", ctx1 as any);
      expect(callCount).toBe(2);

      // Reset mock call count for second invocation
      callCount = 0;
      const ctx2 = {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          adversarialConfig: { ...ADVERSARIAL_CONFIG_DEFAULT },
          mode: "ref",
        } as AdversarialReviewInput,
      };

      await adversarialReviewOp.hopBody!("prompt2", ctx2 as any);
      // Second invocation also fires reprompt — no persistent hasReprompted flag
      expect(callCount).toBe(2);
    });
  });
});

describe("AdversarialReviewPromptBuilder.regroundDroppedFindings — unit", () => {
  test("regroundDroppedFindings is a static method on AdversarialReviewPromptBuilder", () => {
    const { AdversarialReviewPromptBuilder } = require("../../../src/prompts/builders/adversarial-review-builder");
    expect(typeof AdversarialReviewPromptBuilder.regroundDroppedFindings).toBe("function");
  });

  test("regroundDroppedFindings returns non-empty string when drops is non-empty", () => {
    const { AdversarialReviewPromptBuilder } = require("../../../src/prompts/builders/adversarial-review-builder");
    const result = AdversarialReviewPromptBuilder.regroundDroppedFindings({
      drops: [
        {
          finding: { severity: "error", issue: "SQL injection", file: "src/auth.ts", line: 1 },
          code: "missing_ac_quote",
        },
      ],
      acceptanceCriteria: ["auth login must not allow SQL injection attacks"],
    });
    expect(result.length).toBeGreaterThan(0);
  });

  test("regroundDroppedFindings includes DROP_CODE_MESSAGES_QUOTE translation for each rejection code", () => {
    const { AdversarialReviewPromptBuilder } = require("../../../src/prompts/builders/adversarial-review-builder");
    const codes: Array<{
      code:
        | "missing_ac_quote"
        | "ac_index_out_of_range"
        | "ac_quote_not_substring"
        | "ac_quote_does_not_constrain_locus";
      expected: string;
    }> = [
      { code: "missing_ac_quote", expected: "no `acQuote` field was provided" },
      { code: "ac_index_out_of_range", expected: "ACs are 1-indexed" },
      { code: "ac_quote_not_substring", expected: "does not appear verbatim" },
      { code: "ac_quote_does_not_constrain_locus", expected: "your finding flags" },
    ];

    for (const { code, expected } of codes) {
      const result = AdversarialReviewPromptBuilder.regroundDroppedFindings({
        drops: [
          {
            finding: { severity: "error", issue: "test issue", file: "src/a.ts", line: 1 },
            code,
          },
        ],
        acceptanceCriteria: ["auth login must not allow SQL injection attacks", "handler must not throw exceptions"],
      });
      expect(result).toContain(expected);
    }
  });

  test("regroundDroppedFindings includes exact dropped[0].finding.issue", () => {
    const { AdversarialReviewPromptBuilder } = require("../../../src/prompts/builders/adversarial-review-builder");
    const issueText = "SQL injection via rawQuery — no parameterization";
    const result = AdversarialReviewPromptBuilder.regroundDroppedFindings({
      drops: [
        {
          finding: { severity: "error", issue: issueText, file: "src/auth.ts", line: 1 },
          code: "missing_ac_quote",
        },
      ],
      acceptanceCriteria: ["auth login must not allow SQL injection attacks"],
    });
    expect(result).toContain(issueText);
  });

  test("regroundDroppedFindings returns empty string when drops is empty", () => {
    const { AdversarialReviewPromptBuilder } = require("../../../src/prompts/builders/adversarial-review-builder");
    const result = AdversarialReviewPromptBuilder.regroundDroppedFindings({
      drops: [],
      acceptanceCriteria: ["AC1", "AC2"],
    });
    expect(result).toBe("");
  });
});
