/**
 * Tests for timeoutRetry — the wall-clock-timeout retry prompt builder (US-003).
 *
 * AC1: returned string includes the original prompt text.
 * AC2: with non-empty changed files → names each path + instructs to continue
 *      from existing state (not restart).
 * AC3: with empty changed files → states no file changes + instructs to change
 *      approach.
 * AC4: with empty changed files → does NOT instruct to continue from existing
 *      work.
 * AC5: includes the elapsed duration of the timed-out attempt.
 * AC8: when pre-attempt git ref is unavailable (capture fails), resolves to a
 *      prompt containing the generic timeout preamble without throwing.
 */

import { describe, expect, test } from "bun:test";
import { timeoutRetry } from "@/prompts";

describe("timeoutRetry (barrel export AC1)", () => {
  test("imported from src/prompts barrel; returned string includes the original prompt text", () => {
    const prompt = "Do the original work";
    const result = timeoutRetry({
      prompt,
      changedFiles: [],
      elapsedMs: 30_000,
      attempt: 1,
    });
    expect(typeof result).toBe("string");
    expect(result).toContain(prompt);
  });
});

describe("timeoutRetry — non-empty changed file list (AC2)", () => {
  test("names each changed path and instructs to continue from existing state", () => {
    const result = timeoutRetry({
      prompt: "original prompt",
      changedFiles: ["src/foo.ts", "src/bar.ts"],
      elapsedMs: 45_000,
      attempt: 1,
    });
    expect(result).toContain("src/foo.ts");
    expect(result).toContain("src/bar.ts");
    // Names every path — both paths must appear.
    expect(result.split("src/foo.ts").length - 1).toBeGreaterThanOrEqual(1);
    expect(result.split("src/bar.ts").length - 1).toBeGreaterThanOrEqual(1);
    // Instructs to continue, not restart.
    const lower = result.toLowerCase();
    expect(lower).toMatch(/continue/);
    expect(lower).not.toMatch(/start (over|from scratch)/);
  });
});

describe("timeoutRetry — empty changed file list (AC3/AC4)", () => {
  test("states that no file changes were produced and instructs to change approach", () => {
    const result = timeoutRetry({
      prompt: "original prompt",
      changedFiles: [],
      elapsedMs: 45_000,
      attempt: 1,
    });
    const lower = result.toLowerCase();
    // Generic preamble: previous attempt produced no file changes on disk.
    expect(lower).toMatch(/no .*changes/);
    expect(lower).toMatch(/change (your )?approach|different approach/);
  });

  test("does NOT instruct to continue from existing work", () => {
    const result = timeoutRetry({
      prompt: "original prompt",
      changedFiles: [],
      elapsedMs: 45_000,
      attempt: 1,
    });
    const lower = result.toLowerCase();
    expect(lower).not.toMatch(/continue from (the )?existing (state|work|files)/);
  });
});

describe("timeoutRetry — elapsed duration (AC5)", () => {
  test("states the elapsed duration of the timed-out attempt", () => {
    const result = timeoutRetry({
      prompt: "p",
      changedFiles: [],
      elapsedMs: 92_000,
      attempt: 1,
    });
    // Format is implementation-defined; we just require a human-readable form
    // that includes both minutes and seconds (92s = 1m 32s).
    expect(result).toMatch(/1\s*m(in(ute)?s?)?\s*32\s*s(ec(ond)?s?)?/i);
  });
});

describe("timeoutRetry — attempt number reflects the actual retry count", () => {
  test("attempt: 1 states 'attempt 2'", () => {
    const result = timeoutRetry({ prompt: "p", changedFiles: [], elapsedMs: 1_000, attempt: 1 });
    expect(result).toContain("attempt 2");
  });

  test("attempt: 2 (a second configured retry) states 'attempt 3', not 'attempt 2'", () => {
    const result = timeoutRetry({ prompt: "p", changedFiles: [], elapsedMs: 1_000, attempt: 2 });
    expect(result).toContain("attempt 3");
    expect(result).not.toContain("attempt 2");
  });
});

describe("timeoutRetry — generic preamble fallback (AC8)", () => {
  test("does not throw when the pre-attempt git reference is unavailable", () => {
    // The helper takes changedFiles directly; an empty array (the safe-degrade
    // signal when ref capture fails) is the degraded form. The non-throwing
    // contract is verified here.
    expect(() =>
      timeoutRetry({
        prompt: "p",
        changedFiles: [],
        elapsedMs: 1_000,
        attempt: 1,
      }),
    ).not.toThrow();
  });

  test("degraded form still contains the generic timeout preamble", () => {
    const result = timeoutRetry({
      prompt: "p",
      changedFiles: [],
      elapsedMs: 1_000,
      attempt: 1,
    });
    // Generic preamble — phrases common to retry prompts about a wall-clock
    // timeout. We just require a timeout preamble without changed-file guidance.
    const lower = result.toLowerCase();
    expect(lower).toMatch(/timed? ?out|timeout/);
  });
});
