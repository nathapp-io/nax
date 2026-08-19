// RE-ARCH: keep
/**
 * Unit tests for StatusWriter.setPostRunPhase("finish", ...) (Task 1 of
 * finish-wiring-and-cutover). Pure type-widening — pins that the "finish"
 * phase merges into postRun the same way "acceptance" / "regression" do,
 * and that crash recovery rewrites a "running" finish phase to "not-run".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { StatusWriter } from "@/execution";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { join } from "node:path";

let TEST_DIR: string;
let TEST_STATUS_FILE: string;

beforeEach(() => {
  TEST_DIR = makeTempDir("nax-status-writer-finish-");
  TEST_STATUS_FILE = join(TEST_DIR, "status.json");
});

afterEach(() => {
  cleanupTempDir(TEST_DIR);
});

function makeStatusWriter(): StatusWriter {
  return new StatusWriter(TEST_STATUS_FILE, DEFAULT_CONFIG, {
    runId: "test-run",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
}

describe("StatusWriter — finish post-run phase", () => {
  test("setPostRunPhase('finish') merges into postRun and survives crash recovery", () => {
    const writer = makeStatusWriter();
    writer.setPostRunPhase("finish", { status: "running" });
    expect(writer.getPostRunStatus().finish).toEqual({ status: "not-run" });

    writer.setPostRunPhase("finish", {
      status: "passed",
      lastRunAt: "2026-08-19T00:00:00.000Z",
      result: "opened",
      url: "https://github.com/o/r/pull/1",
    });
    expect(writer.getPostRunStatus().finish).toEqual({
      status: "passed",
      lastRunAt: "2026-08-19T00:00:00.000Z",
      result: "opened",
      url: "https://github.com/o/r/pull/1",
    });
  });

  test("absent finish key stays absent when no finish update has been applied", () => {
    const writer = makeStatusWriter();
    writer.setPostRunPhase("acceptance", { status: "passed" });
    expect(writer.getPostRunStatus().finish).toBeUndefined();
  });
});
