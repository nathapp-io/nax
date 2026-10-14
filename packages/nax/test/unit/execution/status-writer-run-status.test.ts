// RE-ARCH: keep
/**
 * US-004: the read-only `runStatus` getter on StatusWriter, which the completion
 * phase reads to decide whether a failed feature workflow must downgrade the run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { StatusWriter } from "@/execution";

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = makeTempDir("nax-status-writer-run-status-");
});

afterEach(() => cleanupTempDir(TEST_DIR));

function makeWriter(): StatusWriter {
  return new StatusWriter(join(TEST_DIR, "status.json"), DEFAULT_CONFIG, {
    runId: "test-run",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
}

describe("StatusWriter — runStatus getter (US-004)", () => {
  test("a writer that has not been told anything reports running", () => {
    expect(makeWriter().runStatus).toBe("running");
  });

  test("the getter reports the value last passed to setRunStatus", () => {
    const writer = makeWriter();
    writer.setRunStatus("cost-limit");
    expect(writer.runStatus).toBe("cost-limit");
    writer.setRunStatus("failed");
    expect(writer.runStatus).toBe("failed");
    expect(writer.runStatus).not.toBe("cost-limit");
  });
});
