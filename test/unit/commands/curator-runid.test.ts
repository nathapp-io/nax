/**
 * Unit tests for `curatorCommit` runId validation (US-002 AC #5).
 *
 * The shared curator test file (`test/unit/commands/curator.test.ts`) already
 * exercises the rest of curatorCommit's behaviour; this file isolates the
 * unsafe-runId boundary so the shared file stays under the 800-line hard limit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeNaxConfig, makeTempDir } from "@test/helpers";
import type { ResolvedProject } from "@/commands/common";
import { _curatorCmdDeps as _deps, curatorCommit } from "@/commands/curator";

function makeResolvedProject(projectDir: string): ResolvedProject {
  return {
    projectDir,
    configPath: join(projectDir, ".nax", "config.json"),
  };
}

describe("curatorCommit — US-002 unsafe runId (AC #5)", () => {
  let tmpDir: string;
  let outputDir: string;
  let capturedOutput: string[];

  const originalResolveProject = _deps.resolveProject;
  const originalReadFile = _deps.readFile;
  const originalLoadConfig = _deps.loadConfig;
  const originalProjectOutputDir = _deps.projectOutputDir;
  const originalGlobalOutputDir = _deps.globalOutputDir;
  const originalCuratorRollupPath = _deps.curatorRollupPath;
  const originalWriteFile = _deps.writeFile;
  const originalAppendFile = _deps.appendFile;
  const originalRemoveFile = _deps.removeFile;
  const originalOpenInEditor = _deps.openInEditor;
  const originalLog = console.log;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-curator-runid-test-");
    outputDir = join(tmpDir, "output");
    mkdirSync(join(outputDir, "runs"), { recursive: true });

    capturedOutput = [];
    console.log = (...args: unknown[]) => {
      capturedOutput.push(args.map(String).join(" "));
    };

    _deps.resolveProject = mock(async (_opts?) => makeResolvedProject(tmpDir));
    _deps.loadConfig = mock(async (_dir?: string) => makeNaxConfig());
    _deps.projectOutputDir = mock(() => outputDir);
    _deps.globalOutputDir = mock(() => tmpDir);
    _deps.curatorRollupPath = mock(() => join(tmpDir, "rollup.jsonl"));
    _deps.writeFile = mock(async () => {});
    _deps.appendFile = mock(async () => {});
    _deps.removeFile = mock(async () => {});
    _deps.openInEditor = mock(async () => {});
  });

  afterEach(() => {
    console.log = originalLog;
    _deps.resolveProject = originalResolveProject;
    _deps.readFile = originalReadFile;
    _deps.loadConfig = originalLoadConfig;
    _deps.projectOutputDir = originalProjectOutputDir;
    _deps.globalOutputDir = originalGlobalOutputDir;
    _deps.curatorRollupPath = originalCuratorRollupPath;
    _deps.writeFile = originalWriteFile;
    _deps.appendFile = originalAppendFile;
    _deps.removeFile = originalRemoveFile;
    _deps.openInEditor = originalOpenInEditor;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rejects a runId that escapes the run directory via path traversal before any file read", async () => {
    let readFileCalled = false;
    _deps.readFile = mock(async (_p: string) => {
      readFileCalled = true;
      return "";
    });

    await expect(curatorCommit({ runId: "../../etc" })).rejects.toMatchObject({
      name: "NaxError",
      code: "INVALID_RUN_ID",
    });
    expect(readFileCalled).toBe(false);
  });
});
