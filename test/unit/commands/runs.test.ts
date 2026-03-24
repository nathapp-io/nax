/**
 * Unit tests for src/commands/runs.ts — runsCommand
 *
 * Tests all acceptance criteria:
 * - Displays table sorted newest-first
 * - --project filter
 * - --last limit
 * - --status filter
 * - Missing statusPath shows '[unavailable]'
 * - Empty registry shows 'No runs found'
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _runsCmdDeps as _deps, runsCommand } from "../../../src/commands/runs";
import type { MetaJson } from "../../../src/pipeline/subscribers/registry";
import type { NaxStatusFile } from "../../../src/execution/status-file";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpRunsDir(): string {
  return mkdtempSync(join(tmpdir(), "nax-runs-test-"));
}

function makeStatusFile(overrides: Partial<NaxStatusFile["run"]> = {}): NaxStatusFile {
  return {
    version: 1,
    run: {
      id: "run-2026-01-01T00-00-00",
      feature: "feat",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
      dryRun: false,
      pid: 1234,
      ...overrides,
    },
    progress: { total: 4, passed: 3, failed: 1, paused: 0, blocked: 0, pending: 0 },
    cost: { spent: 0.12, limit: null },
    current: null,
    iterations: 5,
    updatedAt: "2026-01-01T00:10:00.000Z",
    durationMs: 600000,
  };
}

function writeRun(
  runsDir: string,
  opts: {
    runId: string;
    project: string;
    feature: string;
    registeredAt: string;
    statusFile?: NaxStatusFile | null;
  },
): { metaPath: string; statusPath: string } {
  const runDir = join(runsDir, `${opts.project}-${opts.feature}-${opts.runId}`);
  mkdirSync(runDir, { recursive: true });

  const statusPath = join(runDir, "status.json");

  const meta: MetaJson = {
    runId: opts.runId,
    project: opts.project,
    feature: opts.feature,
    workdir: "/tmp/fake-workdir",
    statusPath,
    eventsDir: "/tmp/fake-workdir/nax/features/feat/runs",
    registeredAt: opts.registeredAt,
  };

  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));

  if (opts.statusFile !== null) {
    const sf = opts.statusFile ?? makeStatusFile();
    writeFileSync(statusPath, JSON.stringify(sf, null, 2));
  }

  return { metaPath: join(runDir, "meta.json"), statusPath };
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tmpDir: string;
let capturedOutput: string[];
const originalLog = console.log;
const originalGetRunsDir = _deps.getRunsDir;

beforeEach(() => {
  tmpDir = makeTmpRunsDir();
  capturedOutput = [];
  console.log = (...args: unknown[]) => {
    capturedOutput.push(args.map(String).join(" "));
  };
  _deps.getRunsDir = () => tmpDir;
});

afterEach(() => {
  console.log = originalLog;
  _deps.getRunsDir = originalGetRunsDir;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runsCommand", () => {
  describe("empty registry", () => {
    test("shows 'No runs found' when registry dir does not exist", async () => {
      _deps.getRunsDir = () => join(tmpDir, "nonexistent");
      await runsCommand();
      expect(capturedOutput.join("\n")).toContain("No runs found");
    });

    test("shows 'No runs found' when registry dir is empty", async () => {
      await runsCommand();
      expect(capturedOutput.join("\n")).toContain("No runs found");
    });
  });

  describe("table display", () => {
    test("displays runs sorted newest-first", async () => {
      writeRun(tmpDir, {
        runId: "run-A",
        project: "proj",
        feature: "feat",
        registeredAt: "2026-01-01T10:00:00.000Z",
        statusFile: makeStatusFile({ status: "completed" }),
      });
      writeRun(tmpDir, {
        runId: "run-B",
        project: "proj",
        feature: "feat",
        registeredAt: "2026-01-02T10:00:00.000Z",
        statusFile: makeStatusFile({ status: "completed" }),
      });

      await runsCommand();

      const output = capturedOutput.join("\n");
      const posA = output.indexOf("run-A");
      const posB = output.indexOf("run-B");
      expect(posB).toBeLessThan(posA); // run-B (newer) should appear before run-A
    });

    test("shows RUN ID, PROJECT, FEATURE, STATUS, STORIES, DURATION, DATE columns", async () => {
      writeRun(tmpDir, {
        runId: "run-X",
        project: "myproj",
        feature: "my-feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: makeStatusFile(),
      });

      await runsCommand();

      const output = capturedOutput.join("\n");
      expect(output).toContain("RUN ID");
      expect(output).toContain("PROJECT");
      expect(output).toContain("FEATURE");
      expect(output).toContain("STATUS");
      expect(output).toContain("STORIES");
      expect(output).toContain("DURATION");
      expect(output).toContain("DATE");
    });

    test("shows run data in table row", async () => {
      writeRun(tmpDir, {
        runId: "run-X",
        project: "myproj",
        feature: "my-feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: makeStatusFile({ status: "completed" }),
      });

      await runsCommand();

      const output = capturedOutput.join("\n");
      expect(output).toContain("run-X");
      expect(output).toContain("myproj");
      expect(output).toContain("my-feat");
      expect(output).toContain("3/4");
    });
  });

  describe("--project filter", () => {
    test("filters runs by project name", async () => {
      writeRun(tmpDir, {
        runId: "run-alpha",
        project: "alpha",
        feature: "feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: makeStatusFile(),
      });
      writeRun(tmpDir, {
        runId: "run-beta",
        project: "beta",
        feature: "feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: makeStatusFile(),
      });

      await runsCommand({ project: "alpha" });

      const output = capturedOutput.join("\n");
      expect(output).toContain("run-alpha");
      expect(output).not.toContain("run-beta");
    });

    test("shows 'No runs found' when project has no runs", async () => {
      writeRun(tmpDir, {
        runId: "run-alpha",
        project: "alpha",
        feature: "feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: makeStatusFile(),
      });

      await runsCommand({ project: "nonexistent" });

      expect(capturedOutput.join("\n")).toContain("No runs found");
    });
  });

  describe("--last limit", () => {
    test("limits output to N most recent runs", async () => {
      for (let i = 1; i <= 5; i++) {
        writeRun(tmpDir, {
          runId: `run-${String(i).padStart(3, "0")}`,
          project: "proj",
          feature: "feat",
          registeredAt: `2026-01-0${i}T00:00:00.000Z`,
          statusFile: makeStatusFile(),
        });
      }

      await runsCommand({ last: 2 });

      const output = capturedOutput.join("\n");
      // Only the 2 newest should appear
      expect(output).toContain("run-005");
      expect(output).toContain("run-004");
      expect(output).not.toContain("run-001");
      expect(output).not.toContain("run-002");
      expect(output).not.toContain("run-003");
    });
  });

  describe("--status filter", () => {
    test("filters runs by status", async () => {
      writeRun(tmpDir, {
        runId: "run-done",
        project: "proj",
        feature: "feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: makeStatusFile({ status: "completed" }),
      });
      writeRun(tmpDir, {
        runId: "run-fail",
        project: "proj",
        feature: "feat",
        registeredAt: "2026-01-02T00:00:00.000Z",
        statusFile: makeStatusFile({ status: "failed" }),
      });

      await runsCommand({ status: "failed" });

      const output = capturedOutput.join("\n");
      expect(output).toContain("run-fail");
      expect(output).not.toContain("run-done");
    });
  });

  describe("missing statusPath", () => {
    test("shows [unavailable] when status file does not exist", async () => {
      writeRun(tmpDir, {
        runId: "run-nostat",
        project: "proj",
        feature: "feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: null, // no status file written
      });

      await runsCommand();

      const output = capturedOutput.join("\n");
      expect(output).toContain("[unavailable]");
      expect(output).toContain("run-nostat");
    });

    test("does not throw when status file is missing", async () => {
      writeRun(tmpDir, {
        runId: "run-nostat",
        project: "proj",
        feature: "feat",
        registeredAt: "2026-01-01T00:00:00.000Z",
        statusFile: null,
      });

      await expect(runsCommand()).resolves.toBeUndefined();
    });
  });
});
