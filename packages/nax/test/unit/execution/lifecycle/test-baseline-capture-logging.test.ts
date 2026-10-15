import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanupTempDir, type LogCall, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config";
import {
  _captureDeps,
  type CaptureRunBaselineOptions,
  captureRunBaseline,
} from "@/execution/lifecycle/test-baseline-capture";
import * as loggerModule from "@/logger";

const originalDeps = { ..._captureDeps };

// A real temp root: `captureRunBaseline` writes the baseline under
// `<root>/.nax/features/<id>/`, so a literal `/tmp/...` root wrote to the host
// and failed confined (EPERM, plus two extra warn logs) whenever no earlier
// file had left a writer mocked.
let root: string;

beforeEach(() => {
  root = makeTempDir("nax-baseline-logging-");
});

function makeOptions(): CaptureRunBaselineOptions {
  const config: NaxConfig = makeNaxConfig({
    execution: { regressionGate: { enabled: true, timeoutSeconds: 60 } },
    quality: { commands: { test: "bun test" } },
  });
  return { root, featureId: "feat-x", config, workdir: root };
}

function installInfoLogSpy(): LogCall[] {
  const logger = makeLogger();
  spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
  return logger.calls;
}

afterEach(() => {
  Object.assign(_captureDeps, originalDeps);
  mock.restore();
  cleanupTempDir(root);
});

describe("captureRunBaseline — issue #2152 logging", () => {
  test("logs the resolved command before capture and the result after a baseline is persisted", async () => {
    const logs = installInfoLogSpy();
    _captureDeps.resolveTestCommands = async () => ["bun test", "bun run test:e2e"];
    _captureDeps.resolveGateTimeoutSeconds = () => 90;
    _captureDeps.runCommand = async () => ({ success: true, output: "", timedOut: false });
    _captureDeps.parseTestOutput = () => ({ passed: 3, failed: 0, failures: [] });
    _captureDeps.captureGitRef = async () => "base-ref";

    await captureRunBaseline(makeOptions());

    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual({
      level: "info",
      stage: "execution",
      message: "Capturing run-start test baseline",
      data: { commands: ["bun test", "bun run test:e2e"], timeoutSeconds: 90 },
    });
    expect(logs[1]).toMatchObject({
      level: "info",
      stage: "execution",
      message: "Run-start test baseline captured",
      data: { passed: 6, failed: 0, entries: 0, baseRef: "base-ref" },
    });
    expect(typeof logs[1]?.data?.durationMs).toBe("number");
  });

  test.each([
    { reason: "gate-disabled", arrange: () => (_captureDeps.regressionGateEnabled = () => false) },
    { reason: "no-test-command", arrange: () => (_captureDeps.resolveTestCommands = async () => undefined) },
    {
      reason: "timeout",
      arrange: () => {
        _captureDeps.resolveTestCommands = async () => "bun test";
        _captureDeps.runCommand = async () => ({ success: false, output: "", timedOut: true });
      },
    },
    {
      reason: "unparseable",
      arrange: () => {
        _captureDeps.resolveTestCommands = async () => "bun test";
        _captureDeps.runCommand = async () => ({ success: false, output: "", timedOut: false });
      },
    },
    {
      reason: "error",
      arrange: () => {
        _captureDeps.resolveTestCommands = async () => "bun test";
        _captureDeps.runCommand = async () => {
          throw new Error("spawn failed");
        };
      },
    },
  ])("logs no-baseline reason `$reason`", async ({ reason, arrange }) => {
    const logs = installInfoLogSpy();
    arrange();

    await captureRunBaseline(makeOptions());

    expect(logs).toContainEqual({
      level: "info",
      stage: "execution",
      message: "No run-start test baseline",
      data: { reason },
    });
  });
});
