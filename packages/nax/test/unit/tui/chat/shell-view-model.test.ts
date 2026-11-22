/**
 * The full-screen shell view as data (US-006): the header row, the footer hint and the body
 * lines, with no component mounted and no clock of their own — the caller passes the time.
 *
 * These are the pure cases of the story: the mounted frame is asserted in
 * `test/ui/chat/shell-view.test.tsx`, which drives the same three functions through `ShellView`.
 */
import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/chat/background";
import { shellViewBody, shellViewFooter, shellViewTitle } from "@/tui/chat/shell-view-model";
import { plainText } from "@/tui/chat/styled-line";

/** A fixed "now", in epoch milliseconds, so an elapsed time is arithmetic and not the wall clock. */
const NOW = 1_700_000_000_000;
const ID = "bash-00000001";
const LOG_PATH = "/logs/bash-00000001.log";
/** The task's start: 75 seconds before NOW while it runs, which reads as `1m 15s`. */
const STARTED_AT = new Date(NOW - 75_000).toISOString();

function shellTask(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: ID,
    command: "npm test",
    origin: "moved",
    startedAt: STARTED_AT,
    state: "running",
    logPath: LOG_PATH,
    ...patch,
  };
}

describe("shellViewTitle", () => {
  test("AC-14 names the state stopped", () => {
    const task = shellTask({ state: "stopped", endedAt: new Date(NOW).toISOString() });
    expect(plainText(shellViewTitle(task, ID, NOW))).toContain("stopped");
  });

  test("names the command and the running state", () => {
    const row = plainText(shellViewTitle(shellTask(), ID, NOW));
    expect(row).toContain("npm test");
    expect(row).toContain("running");
  });

  test("measures a running task's elapsed time from the clock it is given", () => {
    const row = plainText(shellViewTitle(shellTask(), ID, NOW));
    expect(row).toContain("npm test");
    expect(row).toContain("1m 15s");
    // The elapsed time is now - startedAt, not a reading of the wall clock: 60s later reads 2m 15s.
    expect(plainText(shellViewTitle(shellTask(), ID, NOW + 60_000))).toContain("2m 15s");
  });

  test("measures an ended task's duration from its own start and end", () => {
    const task = shellTask({ state: "succeeded", endedAt: new Date(NOW).toISOString() });
    // NOW is ignored once the task has ended: the task's own span is the duration.
    expect(plainText(shellViewTitle(task, ID, NOW + 3_600_000))).toContain("1m 15s");
  });

  test("names the exit code once an ended task carries one", () => {
    const task = shellTask({ state: "failed", exitCode: 2, endedAt: new Date(NOW).toISOString() });
    const row = plainText(shellViewTitle(task, ID, NOW));
    expect(row).toContain("failed");
    expect(row).toContain("exit 2");
  });

  test("puts the description beside the command", () => {
    const row = plainText(shellViewTitle(shellTask({ description: "run the test suite" }), ID, NOW));
    expect(row).toContain("npm test (run the test suite)");
  });

  test("names the id of the task it is drawing", () => {
    expect(plainText(shellViewTitle(shellTask(), ID, NOW))).toContain(ID);
  });

  test("says an unknown id is no longer listed", () => {
    expect(plainText(shellViewTitle(undefined, "bash-00000009", NOW))).toBe("bash-00000009 is no longer listed");
  });
});

describe("shellViewFooter", () => {
  test("AC-15 replaces the hint with the error it is given", () => {
    const row = shellViewFooter(shellTask(), "boom");
    expect(plainText(row)).toBe("boom");
  });

  test("offers to stop a running shell", () => {
    expect(plainText(shellViewFooter(shellTask()))).toBe("esc to return · k to stop");
  });

  test("offers only the way back once the shell ended", () => {
    const ended = shellTask({ state: "failed", exitCode: 1, endedAt: new Date(NOW).toISOString() });
    expect(plainText(shellViewFooter(ended))).toBe("esc to return");
  });

  test("offers only the way back for a task the registry no longer lists", () => {
    expect(plainText(shellViewFooter(undefined))).toBe("esc to return");
  });
});

describe("shellViewBody", () => {
  test("AC-16 returns no lines for a view it does not have", () => {
    expect(shellViewBody(undefined, undefined)).toEqual([]);
  });

  test("draws every tail line, oldest first", () => {
    const lines = shellViewBody({ lines: ["one", "two", "three"], truncated: false }, LOG_PATH);
    expect(lines.map(plainText)).toEqual(["one", "two", "three"]);
  });

  test("names the log path first when earlier output was dropped", () => {
    const lines = shellViewBody({ lines: ["newest"], truncated: true }, LOG_PATH);
    expect(lines.map(plainText)).toEqual([`earlier output dropped; full log: ${LOG_PATH}`, "newest"]);
  });

  test("says only that output was dropped when it has no log path to name", () => {
    const lines = shellViewBody({ lines: [], truncated: true }, undefined);
    expect(lines.map(plainText)).toEqual(["earlier output dropped"]);
  });

  test("neutralises a control sequence a tail line carries", () => {
    const lines = shellViewBody({ lines: ["before\u001b[?1049lafter"], truncated: false }, LOG_PATH);
    expect(lines.map(plainText)).toEqual(["beforeafter"]);
  });
});
