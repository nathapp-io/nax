/**
 * Unit tests for the degraded-baseline evidence added in
 * `src/execution/lifecycle/test-baseline-capture.ts` (US-002):
 *   - AC1   timeout marker carries command / cwd / exitCode / outputTail
 *   - AC2   per-command duration comes from the `clockMs` seam
 *   - AC3   runner throw → `error` evidence, no outputTail
 *   - AC4   unparseable → the first failing command in run order
 *   - AC5   outputTail keeps exactly the last 40 lines
 *   - AC6   outputTail is redacted
 *   - AC7   empty output + no exitCode → neither key present
 *   - AC8   error message is redacted
 *   - AC9   command string is redacted
 *   - AC10  the info line carries the same fields after `reason`
 *   - AC11  gate-disabled carries no evidence
 *   - AC12  no-test-command carries no evidence
 *   - AC13  a captured baseline carries no evidence
 *   - AC14  `gateOutputTail` is reachable through its nested barrel
 *
 * Lives beside `test-baseline-capture.test.ts` (770 of the 800-line cap)
 * rather than inside it.
 *
 * Posture: every impure dep is stubbed through `_captureDeps` and restored from
 * a snapshot; no subprocess and no filesystem write happens.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type LogCall, makeLogger, makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import {
  _captureDeps,
  type CaptureParsedSummary,
  type CaptureRunBaselineOptions,
  type CaptureRunnerResult,
  captureRunBaseline,
} from "@/execution/lifecycle/test-baseline-capture";
import * as loggerModule from "@/logger";
import { GATE_OUTPUT_TAIL_LINES, gateOutputTail } from "@/operations/gate-output-tail";
import type { BaselineEvidence, TestBaseline } from "@/verification";

const originalDeps = { ..._captureDeps };

const SECRET = "sk-aaaaaaaaaaaaaaaaaaaa";

let writes: TestBaseline[];

beforeEach(() => {
  writes = [];
  _captureDeps.clearStoryBaselines = async () => undefined;
  _captureDeps.resolveTestCommands = async () => "bun run test";
  _captureDeps.runCommand = async () => ({ success: false, output: "", timedOut: false });
  _captureDeps.captureGitRef = async () => "base-ref";
  _captureDeps.parseTestOutput = (): CaptureParsedSummary => ({ passed: 0, failed: 0, failures: [] });
  _captureDeps.now = () => "2026-01-15T00:00:00.000Z";
  _captureDeps.regressionGateEnabled = () => true;
  _captureDeps.resolveGateTimeoutSeconds = () => 60;
  _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
    writes.push(baseline);
  };
  _captureDeps.writeStoryBaseline = async () => undefined;
});

afterEach(() => {
  Object.assign(_captureDeps, originalDeps);
  mock.restore();
});

// `/repo` is the root the ACs name. Nothing touches the disk: `writeRunBaseline`
// and `clearStoryBaselines` are stubbed above.
function makeOptions(overrides: Partial<CaptureRunBaselineOptions> = {}): CaptureRunBaselineOptions {
  const config: NaxConfig = makeNaxConfig({
    execution: { regressionGate: { enabled: true, timeoutSeconds: 60 } },
    quality: { commands: { test: "bun run test" } },
  });
  return { root: "/repo", featureId: "feat-x", config, workdir: "/repo", ...overrides };
}

/** The single persisted marker, narrowed to the `no-baseline` arm. */
function onlyMarker(): Extract<TestBaseline, { kind: "no-baseline" }> {
  expect(writes).toHaveLength(1);
  const marker = writes[0];
  expect(marker?.kind).toBe("no-baseline");
  if (marker?.kind !== "no-baseline") throw new Error("expected a no-baseline marker");
  return marker;
}

function onlyEvidence(): BaselineEvidence {
  const evidence = onlyMarker().evidence;
  expect(evidence).toBeDefined();
  if (evidence === undefined) throw new Error("expected evidence");
  return evidence;
}

function installLoggerSpy(): LogCall[] {
  const logger = makeLogger();
  spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
  return logger.calls;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — timeout marker carries the command's evidence
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC1 (timeout command evidence)", () => {
  test("AC1: timed-out command records command, cwd, exitCode and outputTail", async () => {
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: true,
      output: "line1\nline2",
      exitCode: 124,
    });

    await captureRunBaseline(makeOptions());

    const marker = onlyMarker();
    expect(marker.reason).toBe("timeout");
    expect(marker.evidence).toEqual({
      command: "bun run test",
      cwd: ".",
      exitCode: 124,
      durationMs: expect.any(Number),
      outputTail: "line1\nline2",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — duration from the clockMs seam
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC2 (per-command duration)", () => {
  test("AC2: durationMs is the difference between the two clockMs reads around one command", async () => {
    const ticks = [1000, 4500];
    let read = 0;
    _captureDeps.clockMs = () => ticks[read++] ?? 4500;
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: true,
      output: "",
    });

    await captureRunBaseline(makeOptions());

    expect(onlyEvidence().durationMs).toBe(3500);
    expect(read).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — runner throw → error evidence without an outputTail
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC3 (runner throw)", () => {
  test("AC3: a throwing runner records the error message and no outputTail key", async () => {
    _captureDeps.runCommand = async () => {
      throw new Error("spawn failed");
    };

    await captureRunBaseline(makeOptions());

    const marker = onlyMarker();
    expect(marker.reason).toBe("error");
    expect(marker.evidence?.error).toBe("spawn failed");
    expect(marker.evidence).not.toHaveProperty("outputTail");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — unparseable names the first failing command in run order
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC4 (first failing command)", () => {
  test("AC4: unparseable evidence names cmd-b, the first command that failed", async () => {
    _captureDeps.resolveTestCommands = async () => ["cmd-a", "cmd-b", "cmd-c"];
    _captureDeps.runCommand = async (command: string): Promise<CaptureRunnerResult> => ({
      success: command === "cmd-a",
      timedOut: false,
      output: command === "cmd-a" ? "all green" : `${command} noise`,
    });

    await captureRunBaseline(makeOptions());

    const marker = onlyMarker();
    expect(marker.reason).toBe("unparseable");
    expect(marker.evidence?.command).toBe("cmd-b");
  });

  // The root path keeps the aggregate rule (spec US-004: "runs exactly as
  // today"), so a command that names its failures satisfies the whole list and
  // the baseline is captured rather than degraded. The per-command rule lives in
  // `runGroup`, where US-004/AC-14 scopes it to per-package groups.
  test("AC4: a named failure anywhere in the root command list keeps the baseline captured", async () => {
    _captureDeps.resolveTestCommands = async () => ["cmd-a", "cmd-b"];
    _captureDeps.runCommand = async (command: string): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: false,
      output: command,
    });
    _captureDeps.parseTestOutput = (output: string): CaptureParsedSummary =>
      output === "cmd-a"
        ? { passed: 0, failed: 1, failures: [{ file: "a.test.ts", testName: "fails" }] }
        : { passed: 0, failed: 4, failures: [] };

    await captureRunBaseline(makeOptions());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("captured");
    expect(writes[0]).not.toHaveProperty("evidence");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — outputTail keeps exactly the last 40 lines
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC5 (bounded output tail)", () => {
  test("AC5: a 60-line output yields exactly the last 40 lines", async () => {
    const output = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: false,
      output,
    });

    await captureRunBaseline(makeOptions());

    const expected = Array.from({ length: 40 }, (_, i) => `line-${i + 21}`).join("\n");
    expect(onlyEvidence().outputTail).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — outputTail is redacted
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC6 (redacted output tail)", () => {
  test("AC6: a secret in the command output never reaches the marker", async () => {
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: false,
      output: `auth using ${SECRET}`,
    });

    await captureRunBaseline(makeOptions());

    const tail = onlyEvidence().outputTail;
    expect(tail).toBeDefined();
    expect(tail).not.toContain(SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — absent fields are absent keys
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC7 (absent exitCode / outputTail)", () => {
  test("AC7: empty output and no reported exitCode leave both keys off the evidence", async () => {
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: true,
      output: "",
    });

    await captureRunBaseline(makeOptions());

    const evidence = onlyEvidence();
    expect(evidence).not.toHaveProperty("outputTail");
    expect(evidence).not.toHaveProperty("exitCode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — the error message is redacted
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC8 (redacted error)", () => {
  test("AC8: a secret inside the thrown message is redacted", async () => {
    _captureDeps.runCommand = async () => {
      throw new Error(`auth failed for ${SECRET}`);
    };

    await captureRunBaseline(makeOptions());

    const error = onlyEvidence().error;
    expect(error).toBeDefined();
    expect(error).not.toContain(SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — the command string is redacted
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC9 (redacted command)", () => {
  test("AC9: a secret inside the command string is redacted", async () => {
    _captureDeps.resolveTestCommands = async () => `TOKEN=${SECRET} bun run test`;
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: true,
      output: "",
    });

    await captureRunBaseline(makeOptions());

    const command = onlyEvidence().command;
    expect(command).not.toContain(SECRET);
    // The shape of the command survives redaction — otherwise the evidence is useless.
    expect(command).toContain("bun run test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — the info line carries the same fields after `reason`
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC10 (info line)", () => {
  test("AC10: an unparseable failure with output logs reason plus the evidence fields", async () => {
    const logs = installLoggerSpy();
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: false,
      timedOut: false,
      output: "ModuleNotFoundError: nope",
      exitCode: 2,
    });

    await captureRunBaseline(makeOptions());

    expect(logs).toContainEqual({
      level: "info",
      stage: "execution",
      message: "No run-start test baseline",
      data: {
        reason: "unparseable",
        command: "bun run test",
        cwd: ".",
        exitCode: 2,
        durationMs: expect.any(Number),
        outputTail: "ModuleNotFoundError: nope",
      },
    });
    // `reason` stays the first key so the log line keeps its old shape.
    const entry = logs.find((l) => l.message === "No run-start test baseline");
    expect(Object.keys(entry?.data ?? {})[0]).toBe("reason");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11 + AC12 + AC13 — markers not caused by a command carry no evidence
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline evidence — AC11 (gate-disabled carries none)", () => {
  test("AC11: a disabled regression gate writes no evidence key", async () => {
    _captureDeps.regressionGateEnabled = () => false;

    await captureRunBaseline(makeOptions());

    expect(onlyMarker().reason).toBe("gate-disabled");
    expect(writes[0]).not.toHaveProperty("evidence");
  });
});

describe("captureRunBaseline evidence — AC12 (no-test-command carries none)", () => {
  test("AC12: a repo with no test command writes no evidence key", async () => {
    _captureDeps.resolveTestCommands = async () => undefined;

    await captureRunBaseline(makeOptions());

    expect(onlyMarker().reason).toBe("no-test-command");
    expect(writes[0]).not.toHaveProperty("evidence");
  });
});

describe("captureRunBaseline evidence — AC13 (captured baseline carries none)", () => {
  test("AC13: a green command writes a captured baseline with no evidence key", async () => {
    _captureDeps.runCommand = async (): Promise<CaptureRunnerResult> => ({
      success: true,
      timedOut: false,
      output: "all green",
    });
    _captureDeps.parseTestOutput = () => ({ passed: 7, failed: 0, failures: [] });

    await captureRunBaseline(makeOptions());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("captured");
    expect(writes[0]).not.toHaveProperty("evidence");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14 — gateOutputTail through its nested barrel
// ─────────────────────────────────────────────────────────────────────────────

describe("gateOutputTail barrel — AC14", () => {
  test("AC14: the nested barrel exports gateOutputTail, which keeps the last 40 of 50 lines", () => {
    const output = Array.from({ length: 50 }, (_, i) => `row-${i + 1}`).join("\n");

    const tail = gateOutputTail(output);

    expect(GATE_OUTPUT_TAIL_LINES).toBe(40);
    expect(tail.split("\n")).toHaveLength(40);
    expect(tail.split("\n")[0]).toBe("row-11");
    expect(tail.split("\n")[39]).toBe("row-50");
  });
});
