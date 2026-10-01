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
import type { AdapterFailure } from "@/context/engine";
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

describe("timeoutRetry — non-timeout failure variants (US-005)", () => {
  const P = "Original prompt text for the story";
  const spin: AdapterFailure = { category: "quality", outcome: "fail-spin", retriable: true, message: "spin" };
  const incomplete: AdapterFailure = {
    category: "quality",
    outcome: "fail-incomplete",
    retriable: true,
    message: "incomplete",
  };

  test("US-005 AC9: fail-spin names the spin, the attempt, the changed file and the prompt", () => {
    const result = timeoutRetry({
      prompt: P,
      changedFiles: ["src/a.ts"],
      elapsedMs: 42_000,
      attempt: 1,
      failure: spin,
    });
    expect(result).toContain("kept repeating the same tool calls");
    expect(result).toContain("This was not a timeout. This is attempt 2 of the same story.");
    expect(result).toContain("- src/a.ts");
    expect(result).toContain(P);
  });

  test("US-005 AC10: fail-spin never claims a timeout", () => {
    const result = timeoutRetry({
      prompt: P,
      changedFiles: ["src/a.ts"],
      elapsedMs: 42_000,
      attempt: 1,
      failure: spin,
    });
    expect(result).not.toContain("hit a timeout");
  });

  test("US-005 AC11: fail-incomplete with no changed files names the early turn end and the empty tree", () => {
    const result = timeoutRetry({
      prompt: P,
      changedFiles: [],
      elapsedMs: 42_000,
      attempt: 1,
      failure: incomplete,
    });
    expect(result).toContain("ended its turn before finishing the story");
    expect(result).toContain("This was not a timeout.");
    expect(result).toContain("The previous attempt left no file changes on disk.");
  });

  test("US-005 AC12: fail-incomplete never claims a timeout", () => {
    const result = timeoutRetry({
      prompt: P,
      changedFiles: [],
      elapsedMs: 42_000,
      attempt: 1,
      failure: incomplete,
    });
    expect(result).not.toContain("hit a timeout");
  });

  test("US-005 AC13: fail-timeout keeps the timeout preamble byte-for-byte", () => {
    const timedOut: AdapterFailure = {
      category: "quality",
      outcome: "fail-timeout",
      retriable: true,
      message: "timeout",
    };
    const result = timeoutRetry({
      prompt: P,
      changedFiles: [],
      elapsedMs: 42_000,
      attempt: 1,
      failure: timedOut,
    });
    expect(result.startsWith("The previous attempt hit a timeout after")).toBe(true);
    expect(result).not.toContain("This was not a timeout.");
  });

  test("US-005 AC14: an absent failure keeps the timeout preamble byte-for-byte", () => {
    const result = timeoutRetry({ prompt: P, changedFiles: [], elapsedMs: 42_000, attempt: 1 });
    expect(result.startsWith("The previous attempt hit a timeout after")).toBe(true);
    expect(result).not.toContain("This was not a timeout.");
  });
});

describe("timeoutRetry — the lane was opened by an invalid tool call (nax#2200)", () => {
  const invalidCall: AdapterFailure = {
    category: "quality",
    outcome: "fail-invalid-tool-call",
    retriable: true,
    message: "m",
    invalidToolCall: { tool: "Git", property: "diffFilter", expected: "one of: A, M, D, R", actual: "null" },
  };

  test("names the rejected tool, property and expected shape, and never claims a timeout", () => {
    const result = timeoutRetry({
      prompt: "original prompt",
      changedFiles: [],
      elapsedMs: 42_000,
      attempt: 1,
      failure: invalidCall,
    });
    expect(result).toContain("`Git`");
    expect(result).toContain("`diffFilter`");
    expect(result).toContain("one of: A, M, D, R");
    expect(result).toContain("got null");
    expect(result).toContain("This was not a timeout.");
    expect(result).not.toContain("hit a timeout");
    expect(result).not.toContain("42000ms");
    expect(result).toContain("attempt 2");
    expect(result.endsWith("original prompt")).toBe(true);
  });

  test("tells the model to continue from files the stopped attempt left on disk", () => {
    const result = timeoutRetry({
      prompt: "p",
      changedFiles: ["src/a.ts"],
      elapsedMs: 1_000,
      attempt: 1,
      failure: invalidCall,
    });
    expect(result).toContain("- src/a.ts");
    expect(result.toLowerCase()).toContain("do not revert");
  });

  test("without the call's detail it still reports an invalid tool call, not a timeout", () => {
    const { invalidToolCall: _omit, ...bare } = invalidCall;
    const result = timeoutRetry({ prompt: "p", changedFiles: [], elapsedMs: 1_000, attempt: 1, failure: bare });
    expect(result).toContain("invalid tool call");
    expect(result).not.toContain("hit a timeout");
  });

  test("any other timeout-lane failure keeps the timeout preamble", () => {
    const timedOut: AdapterFailure = { category: "quality", outcome: "fail-timeout", retriable: true, message: "m" };
    const result = timeoutRetry({ prompt: "p", changedFiles: [], elapsedMs: 1_000, attempt: 1, failure: timedOut });
    expect(result).toContain("hit a timeout");
  });
});
