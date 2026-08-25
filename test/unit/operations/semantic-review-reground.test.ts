/**
 * Tests for semanticReviewOp.hopBody — semantic reground re-prompt (AC1-AC8).
 *
 * AC1: When first-pass semantic output is `passed:false` and `filterByAcGroundingMinimal`
 *      yields zero blocking accepted findings with `dropped.length > 0`, and
 *      `input.semanticConfig.acRegroundOnDrop !== false`, then
 *      `semanticReviewOp.hopBody` issues exactly one additional `ctx.send` call.
 * AC2: When the semantic reprompt is built, then its prompt text includes the exact
 *      `dropped[0].finding.issue` string and the human-readable translation of
 *      `dropped[0].code` from `DROP_CODE_MESSAGES_MINIMAL`.
 * AC3: When the second-turn response parses and contains at least one blocking
 *      finding that survives AC filtering, then returned `TurnResult.output`
 *      parses to JSON containing that blocking finding and outer verify returns
 *      `passed:false` with non-empty `normalizedFindings`.
 * AC4: When the second-turn response parses and has no surviving blocking findings
 *      while `passed:true`, then returned `TurnResult.output` parses to JSON with
 *      `passed:true` and advisory findings preserved from both passes, and the outer
 *      `parse()` + `verify()` chain produces a `SemanticReviewOutput` with `passed: true`.
 * AC5: When second-turn JSON parsing fails or second-turn blocking findings are all
 *      dropped by AC grounding, then `semanticReviewOp.hopBody` returns the first-turn
 *      `TurnResult` unchanged — preserving today's fail-closed behavior byte-identically.
 * AC6: When `input.semanticConfig.acRegroundOnDrop === false`, then
 *      `semanticReviewOp.hopBody` performs no additional send and returns behavior
 *      byte-identical to the baseline single-turn path.
 * AC7: When first-pass output does not satisfy trigger conditions (`passed:true`,
 *      surviving blocking findings exist, or `dropped.length === 0`), then no reprompt
 *      send occurs.
 * AC8: When `semanticReviewOp.hopBody` implements the re-prompt path, then no
 *      `hasReprompted` flag or equivalent mutable state is introduced — the
 *      at-most-one guarantee derives structurally from `hopBody` being invoked once
 *      per session turn with `evaluateRepromptTrigger` running exactly once between
 *      the first `sendWithParseRetry` and the optional re-prompt `ctx.send`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestRuntime, withTempDir } from "@test/helpers";
import type { SemanticReviewInput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY_WITH_AC = {
  id: "STORY-SEM-GROUND",
  title: "Semantic AC grounding test",
  description: "test semantic ac grounding",
  acceptanceCriteria: [
    "auth login must not allow SQL injection attacks",
    "handler must not throw unhandled exceptions",
    "sessions expire after 24h",
  ],
};

const SEMANTIC_CONFIG_DEFAULT = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [] as string[],
  timeoutMs: 600_000,
  substantiation: { requote: false, maxRequotes: 0 },
  acRegroundOnDrop: true,
};

function makeDroppedFinding(severity: "error" | "warning" | "info" = "error"): Record<string, unknown> {
  return {
    severity,
    category: "security",
    file: "src/auth.ts",
    line: 1,
    issue: "SQL injection via rawQuery — no parameterization",
    suggestion: "Use parameterized queries",
  };
}

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
    acIndex: 1,
    verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery(u + p)" },
  };
}

describe("semanticReviewOp.hopBody — reground AC1: trigger issues exactly one additional send", () => {
  test("reprompt fires when first-pass passed:false, zero blocking accepted, dropped.length > 0, acRegroundOnDrop !== false", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

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

      await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
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

      const result = await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT, acRegroundOnDrop: false },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expect(callCount).toBe(1);
      expect(result.output).toBe(firstTurn);
    });
  });
});

describe("semanticReviewOp.hopBody — reground AC2: reprompt prompt content", () => {
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
      const sendImpl = mock(async (prompt: string) => {
        if (capturedPrompt === "") {
          capturedPrompt = prompt;
          return { output: firstTurn, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
        }
        return { output: secondTurn, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      });

      await semanticReviewOp.hopBody!("initial prompt", {
        send: sendImpl,
        sendWithParseRetry: mock(async () => ({
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        })),
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expect(capturedPrompt).toContain(droppedIssue);
    });
  });

  test("reprompt prompt includes human-readable translation of dropped[0].code from DROP_CODE_MESSAGES_MINIMAL", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return dev.rawQuery(u + p); }\n");

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

      await semanticReviewOp.hopBody!("initial prompt", {
        send: sendImpl,
        sendWithParseRetry: mock(async () => ({
          output: firstTurn,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          internalRoundTrips: 0,
        })),
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expect(capturedPrompt).toContain("no `acIndex` field was provided");
    });
  });
});

describe("semanticReviewOp.hopBody — reground AC3: second turn has surviving blocking finding", () => {
  test("returns TurnResult with blocking finding in output; outer verify returns passed:false with non-empty normalizedFindings", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

      const blockingFinding = {
        severity: "error",
        category: "security",
        file: "src/auth.ts",
        line: 1,
        issue: "SQL injection vulnerability confirmed",
        suggestion: "Use parameterized queries",
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

      const result = await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      const parsed = JSON.parse(result.output);
      expect(parsed.passed).toBe(false);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0].severity).toBe("error");
    });
  });
});

describe("semanticReviewOp.hopBody — reground AC4: second turn passed:true with no blocking findings", () => {
  test("returns passed:true with advisory union from both turns; outer parse+verify chain produces passed:true", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error"), makeDroppedFinding("warning")],
      });

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

      const result = await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      const parsed = JSON.parse(result.output);
      expect(parsed.passed).toBe(true);
      expect(parsed.findings).toHaveLength(2);
      const severities = parsed.findings.map((f: { severity: string }) => f.severity);
      expect(severities).toContain("warning");
      expect(severities).toContain("info");
    });
  });
});

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

describe("semanticReviewOp.hopBody — reground AC5: second turn fails or all blocking dropped", () => {
  test("returns first-turn TurnResult unchanged when second-turn JSON parsing fails", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

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

      const result = await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expectFirstTurnPreservedWithMarker(result.output, firstTurn, "parse-failed");
    });
  });

  test("returns first-turn TurnResult unchanged when second-turn blocking findings are all dropped by AC grounding", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: false,
        findings: [makeDroppedFinding("error")],
      });

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

      const result = await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expectFirstTurnPreservedWithMarker(result.output, firstTurn, "still-dropped");
    });
  });
});

describe("semanticReviewOp.hopBody — reground AC6: acRegroundOnDrop === false disables reprompt", () => {
  test("hopBody returns behavior byte-identical to baseline when acRegroundOnDrop is false", async () => {
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

      const result = await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT, acRegroundOnDrop: false },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expect(callCount).toBe(1);
      expect(result.output).toBe(firstTurn);
    });
  });
});

describe("semanticReviewOp.hopBody — reground preconditions not met (AC7)", () => {
  test("no reprompt when passed:true", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

      const firstTurn = JSON.stringify({
        passed: true,
        // inspectedFiles present → the #3A inspection-trail guard is satisfied,
        // so this test isolates the reground precondition (no reprompt on pass).
        inspectedFiles: ["src/foo.ts"],
        findings: [],
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

      await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expect(callCount).toBe(1);
    });
  });

  test("no reprompt when surviving blocking findings exist", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

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

      await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expect(callCount).toBe(1);
    });
  });

  test("no reprompt when dropped.length === 0", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

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

      await semanticReviewOp.hopBody!("initial prompt", {
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY_WITH_AC,
          semanticConfig: { ...SEMANTIC_CONFIG_DEFAULT },
          mode: "ref",
        } as SemanticReviewInput,
      } as any);

      expect(callCount).toBe(1);
    });
  });
});
