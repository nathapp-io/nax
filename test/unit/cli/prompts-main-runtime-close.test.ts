/**
 * BUG-24: `nax prompts` (promptsCommand) leaked its runtime on every path —
 * createRuntime() was never closed, leaving ACP sessions/streams, auditors,
 * and the idle-watchdog subscription alive until process exit.
 *
 * These tests exercise the early-throw path (after runtime creation, before
 * the story loop) since it doesn't require the full routing/context/prompt
 * pipeline to succeed — the fix (try/finally around runtime.close()) covers
 * both paths identically, so proving close() fires on the throw path is a
 * faithful regression test for the leak.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMockRuntime, makeTempDir } from "@test/helpers";
import { _promptsMainDeps, promptsCommand } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";

describe("promptsCommand — runtime lifecycle (BUG-24)", () => {
  let tempDir: string;
  let origCreateRuntime: typeof _promptsMainDeps.createRuntime;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-main-test-");
    mkdirSync(join(tempDir, ".nax", "features", "test-feature"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "features", "test-feature", "prd.json"),
      JSON.stringify({
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: [
          {
            id: "US-001",
            title: "Story one",
            description: "desc",
            acceptanceCriteria: ["AC-1"],
            tags: [],
            dependencies: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
          },
        ],
      }),
    );
    origCreateRuntime = _promptsMainDeps.createRuntime;
  });

  afterEach(() => {
    _promptsMainDeps.createRuntime = origCreateRuntime;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("closes the runtime when the requested storyId is not found (throw after runtime creation)", async () => {
    const runtime = makeMockRuntime({ config: DEFAULT_CONFIG, workdir: tempDir });
    const closeSpy = spyOn(runtime, "close");
    _promptsMainDeps.createRuntime = () => runtime;

    await expect(
      promptsCommand({
        feature: "test-feature",
        workdir: tempDir,
        config: DEFAULT_CONFIG,
        storyId: "US-DOES-NOT-EXIST",
      }),
    ).rejects.toThrow('Story "US-DOES-NOT-EXIST" not found');

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
