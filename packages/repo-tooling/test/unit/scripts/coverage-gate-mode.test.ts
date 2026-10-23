import { describe, expect, test } from "bun:test";
import {
  coverageExitCode,
  coverageGateMode,
  finishCoverage,
  SANDBOXED_COVERAGE_NOTE,
} from "#scripts/coverage-gate-mode";

const aggregateFailure = "lines 79.00% < 80.00%";
const note = "[coverage] sandboxed run (NAX_SANDBOXED=1): per-file floors not enforced (CI enforces them)";

describe("coverageGateMode", () => {
  test.each([
    ["AC-1", { NAX_SANDBOXED: "1" }, "sandboxed"],
    ["AC-2", {}, "enforce"],
    ["AC-3", { NAX_SANDBOXED: "0" }, "enforce"],
    ["AC-4", { NAX_SANDBOXED: "true" }, "enforce"],
  ] as const)("%s selects the exact environment mode", (_ac, env, expected) => {
    expect(coverageGateMode(env)).toBe(expected);
  });
});

describe("coverageExitCode", () => {
  test.each([
    ["AC-5", [], false, true, "sandboxed", 0],
    ["AC-6", [], true, false, "sandboxed", 0],
    ["AC-7", [aggregateFailure], true, true, "sandboxed", 1],
    ["AC-8", [], false, true, "enforce", 1],
    ["AC-9", [], true, false, "enforce", 1],
    ["AC-10", [], true, true, "enforce", 0],
  ] as const)("%s preserves aggregate enforcement", (_ac, aggregateFailures, perFileOk, allFilesOk, mode, expected) => {
    expect(coverageExitCode({ aggregateFailures, perFileOk, allFilesOk, mode })).toBe(expected);
  });
});

describe("SANDBOXED_COVERAGE_NOTE", () => {
  test("AC-11 has the exact CI enforcement note", () => {
    expect(SANDBOXED_COVERAGE_NOTE).toBe(note);
  });
});

function capture(options: {
  env: Record<string, string | undefined>;
  perFileOk?: boolean;
  allFilesOk?: boolean;
  aggregateFailures?: string[];
}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = finishCoverage({
    perFileOk: true,
    allFilesOk: true,
    aggregateFailures: [],
    ...options,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });
  return { code, logs, errors };
}

describe("finishCoverage", () => {
  test("AC-12/13/14 reports sandboxed per-file failures without enforcing them", () => {
    const { code, logs, errors } = capture({ env: { NAX_SANDBOXED: "1" }, perFileOk: false });
    expect(code).toBe(0);
    expect(logs).toContain(note);
    expect(logs).toContain(
      "\n[coverage] OK (sandboxed) — aggregate at or above floor; per-file results above are report-only.",
    );
    expect(errors).toEqual([]);
  });

  test("AC-15/16 enforces per-file failures outside the sandbox", () => {
    const { code, logs } = capture({ env: {}, perFileOk: false });
    expect(code).toBe(1);
    expect(logs).not.toContain(note);
    expect(logs).toEqual([]);
  });

  test("AC-17/18 reports and enforces aggregate failures even in the sandbox", () => {
    const { code, logs, errors } = capture({ env: { NAX_SANDBOXED: "1" }, aggregateFailures: [aggregateFailure] });
    expect(code).toBe(1);
    expect(logs).toEqual([note]);
    expect(errors[0]).toBe(`\n[coverage] FAIL — ${aggregateFailure}`);
    expect(errors).toHaveLength(3);
  });

  test("AC-19/20 reports normal success with the existing leading newline", () => {
    const { code, logs, errors } = capture({ env: {} });
    expect(code).toBe(0);
    expect(logs).toEqual(["\n[coverage] OK — at or above floor."]);
    expect(errors).toEqual([]);
  });

  test.each([undefined, "0", "true", "", "yes", "2"])(
    "AC-23 enforces both file checks for NAX_SANDBOXED=%s",
    (value) => {
      for (const flags of [{ perFileOk: false }, { allFilesOk: false }]) {
        const { code, logs } = capture({ env: { NAX_SANDBOXED: value }, ...flags });
        expect(code).toBe(1);
        expect(logs).toEqual([]);
      }
    },
  );

  test("reports sandboxed unreported failures and normal success distinctly", () => {
    expect(capture({ env: { NAX_SANDBOXED: "1" }, allFilesOk: false }).code).toBe(0);
    expect(capture({ env: { NAX_SANDBOXED: "1" } }).logs).toEqual([note, "\n[coverage] OK — at or above floor."]);
  });
});
