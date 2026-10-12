/**
 * US-002 — `nax doctor`, an alias for `nax precheck --light`.
 *
 * The command runs the CLI trust gate first, then delegates to the light
 * precheck verbatim, so its output and exit codes are precheck's.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { _doctorDeps, doctorCommand } from "@/commands/doctor";
import { type PrecheckOptions, precheckCommand } from "@/commands/precheck";

const LITERAL_AUTHORIZATION_HEADER = {
  reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } },
};

/** Write the fixture's project config — a literal header the scanner flags. */
function writeRootConfig(root: string, value: unknown): void {
  const naxDir = join(root, ".nax");
  mkdirSync(naxDir, { recursive: true });
  writeFileSync(join(naxDir, "config.json"), JSON.stringify(value));
}

interface CapturedRun {
  logs: string[];
  exitCodes: number[];
}

/** Run a command with console.log and process.exit captured, then restored. */
async function captureCommand(fn: () => Promise<void>): Promise<CapturedRun> {
  const logs: string[] = [];
  const exitCodes: number[] = [];
  const originalLog = console.log;
  const originalExit = process.exit;
  console.log = (msg: string) => {
    logs.push(msg);
  };
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
  }) as typeof process.exit;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }
  return { logs, exitCodes };
}

/** Pull the pretty-printed JSON payload out of a command's console output. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLine(logs: string[]): Record<string, unknown> {
  const line = logs.find((entry) => entry.trimStart().startsWith("{"));
  assertDefined(line, "JSON precheck output line");
  const payload: unknown = JSON.parse(line);
  if (!isRecord(payload)) throw new Error("Expected a JSON object from precheck");
  return payload;
}

function warningNames(payload: Record<string, unknown>): string[] {
  const warnings = payload.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.flatMap((entry) => (isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []));
}

describe("doctorCommand — dependency wiring", () => {
  let originalRunTrustGate: typeof _doctorDeps.runTrustGate;
  let originalPrecheckCommand: typeof _doctorDeps.precheckCommand;

  beforeEach(() => {
    originalRunTrustGate = _doctorDeps.runTrustGate;
    originalPrecheckCommand = _doctorDeps.precheckCommand;
  });

  afterEach(() => {
    _doctorDeps.runTrustGate = originalRunTrustGate;
    _doctorDeps.precheckCommand = originalPrecheckCommand;
  });

  test("AC7: awaits runTrustGate for the requested directory before precheck runs", async () => {
    const calls: string[] = [];
    _doctorDeps.runTrustGate = async (dir: string) => {
      await Promise.resolve();
      calls.push(`trust:${dir}`);
    };
    _doctorDeps.precheckCommand = async () => {
      calls.push("precheck");
    };

    await doctorCommand({ dir: "/repo", json: true });

    expect(calls).toEqual(["trust:/repo", "precheck"]);
  });

  test("AC8: invokes precheckCommand once with the light precheck options", async () => {
    _doctorDeps.runTrustGate = async () => {};
    const precheckCommandMock = mock(async (_options: PrecheckOptions) => {});
    _doctorDeps.precheckCommand = precheckCommandMock;

    await doctorCommand({ dir: "/repo", json: true });

    expect(precheckCommandMock).toHaveBeenCalledTimes(1);
    expect(precheckCommandMock).toHaveBeenCalledWith({ dir: "/repo", json: true, light: true });
  });
});

describe("doctorCommand — light precheck output", () => {
  let root: string;
  let originalRunTrustGate: typeof _doctorDeps.runTrustGate;
  let originalPrecheckCommand: typeof _doctorDeps.precheckCommand;

  beforeEach(() => {
    root = makeTempDir("nax-doctor-");
    originalRunTrustGate = _doctorDeps.runTrustGate;
    originalPrecheckCommand = _doctorDeps.precheckCommand;
  });

  afterEach(() => {
    _doctorDeps.runTrustGate = originalRunTrustGate;
    _doctorDeps.precheckCommand = originalPrecheckCommand;
    cleanupTempDir(root);
  });

  test("AC9: nax doctor --json reports config-secrets in the printed warnings", async () => {
    writeRootConfig(root, LITERAL_AUTHORIZATION_HEADER);

    const { logs } = await captureCommand(() => doctorCommand({ dir: root, json: true }));

    expect(warningNames(parseJsonLine(logs))).toContain("config-secrets");
  });

  test("AC9 boundary: nax doctor --json omits config-secrets for a clean config", async () => {
    writeRootConfig(root, {});

    const { logs } = await captureCommand(() => doctorCommand({ dir: root, json: true }));

    expect(warningNames(parseJsonLine(logs))).not.toContain("config-secrets");
  });

  test("AC10: renders the same JSON payload as precheck --light", async () => {
    writeRootConfig(root, LITERAL_AUTHORIZATION_HEADER);

    const doctor = await captureCommand(() => doctorCommand({ dir: root, json: true }));
    const precheck = await captureCommand(() => precheckCommand({ dir: root, json: true, light: true }));

    expect(parseJsonLine(doctor.logs)).toEqual(parseJsonLine(precheck.logs));
  });

  test("AC10 boundary: exits with the same code as precheck --light on a blocker", async () => {
    writeRootConfig(root, LITERAL_AUTHORIZATION_HEADER);

    const doctor = await captureCommand(() => doctorCommand({ dir: root, json: true }));
    const precheck = await captureCommand(() => precheckCommand({ dir: root, json: true, light: true }));

    expect(doctor.exitCodes).toEqual(precheck.exitCodes);
  });
});
