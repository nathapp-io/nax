/**
 * Tests for adversarialReviewOp.hopBody — same-session requote recovery (AC15, AC16).
 *
 * Run RED first (hopBody is undefined), then implement in Task 16.
 *
 * AC15: adversarialReviewOp has a hopBody
 * AC16: hopBody triggers same-session requote for blocking findings with unmatched evidence
 *        (mirrors semantic side, uses AdversarialReviewPromptBuilder.requoteVerbatim)
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTurnResult, withTempDir } from "@test/helpers";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { NaxRuntime } from "@/runtime";

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
