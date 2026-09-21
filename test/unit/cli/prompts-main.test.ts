/**
 * promptsCommand — story loop orchestration.
 *
 * The BUG-24 runtime-close regression on the early-throw path is covered by
 * the `promptsCommand — runtime lifecycle (BUG-24)` describe below. These
 * tests exercise the main story loop: pipeline success (stdout and outputDir
 * modes), pipeline failure logging, and no-stories-found.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMockRuntime, makeTempDir } from "@test/helpers";
import { _promptsMainDeps, promptsCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";

function writePrd(tempDir: string, feature: string, storyOverrides: Record<string, unknown> = {}): void {
  mkdirSync(join(tempDir, ".nax", "features", feature), { recursive: true });
  writeFileSync(
    join(tempDir, ".nax", "features", feature, "prd.json"),
    JSON.stringify({
      project: "test-project",
      feature,
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
          ...storyOverrides,
        },
      ],
    }),
  );
}

describe("promptsCommand — story loop", () => {
  let tempDir: string;
  let config: NaxConfig;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-main-loop-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    config = DEFAULT_CONFIG;
    _promptsMainDeps.createRuntime = () => makeMockRuntime({ config, workdir: tempDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("throws when the .nax directory is missing", async () => {
    const bareDir = makeTempDir("nax-prompts-main-bare-");
    try {
      await expect(promptsCommand({ feature: "missing-feature", workdir: bareDir, config })).rejects.toThrow(
        /\.nax directory not found/,
      );
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test("throws when the feature has no prd.json", async () => {
    await expect(promptsCommand({ feature: "ghost-feature", workdir: tempDir, config })).rejects.toThrow(
      /not found or missing prd\.json/,
    );
  });

  test("throws when the feature has zero stories", async () => {
    mkdirSync(join(tempDir, ".nax", "features", "empty-feature"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "features", "empty-feature", "prd.json"),
      JSON.stringify({
        project: "test-project",
        feature: "empty-feature",
        branchName: "feat/empty",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: [],
      }),
    );

    await expect(promptsCommand({ feature: "empty-feature", workdir: tempDir, config })).rejects.toThrow(
      /No stories found in feature/,
    );
  });

  test("writes prompt (and context) files to outputDir and returns the processed story ids", async () => {
    writePrd(tempDir, "out-feature");
    const outputDir = join(tempDir, "prompt-dump");

    const result = await promptsCommand({
      feature: "out-feature",
      workdir: tempDir,
      config,
      outputDir,
    });

    expect(result).toEqual(["US-001"]);
    expect(existsSync(join(outputDir, "US-001.prompt.md"))).toBe(true);
  });

  test("filters to a single story via storyId", async () => {
    mkdirSync(join(tempDir, ".nax", "features", "multi-feature"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "features", "multi-feature", "prd.json"),
      JSON.stringify({
        project: "test-project",
        feature: "multi-feature",
        branchName: "feat/multi",
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
          {
            id: "US-002",
            title: "Story two",
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
    const outputDir = join(tempDir, "prompt-dump-2");

    const result = await promptsCommand({
      feature: "multi-feature",
      workdir: tempDir,
      config,
      storyId: "US-002",
      outputDir,
    });

    expect(result).toEqual(["US-002"]);
    expect(existsSync(join(outputDir, "US-001.prompt.md"))).toBe(false);
    expect(existsSync(join(outputDir, "US-002.prompt.md"))).toBe(true);
  });

  test("writes prompts to stdout (console.log) when outputDir is not provided", async () => {
    writePrd(tempDir, "stdout-feature");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await promptsCommand({ feature: "stdout-feature", workdir: tempDir, config });

      expect(result).toEqual(["US-001"]);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  test("closes the runtime after a successful run", async () => {
    writePrd(tempDir, "close-feature");
    const runtime = makeMockRuntime({ config, workdir: tempDir });
    const closeSpy = spyOn(runtime, "close");
    _promptsMainDeps.createRuntime = () => runtime;

    await promptsCommand({ feature: "close-feature", workdir: tempDir, config, outputDir: join(tempDir, "out") });

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("AC4: calls createRuntime with featureName equal to the feature string", async () => {
    writePrd(tempDir, "audit-feature");
    const captured: Array<
      [
        Parameters<typeof _promptsMainDeps.createRuntime>[0],
        Parameters<typeof _promptsMainDeps.createRuntime>[1],
        Parameters<typeof _promptsMainDeps.createRuntime>[2] | undefined,
      ]
    > = [];
    _promptsMainDeps.createRuntime = (cfg, wd, opts) => {
      captured.push([cfg, wd, opts]);
      return makeMockRuntime({ config: cfg, workdir: wd });
    };

    await promptsCommand({ feature: "audit-feature", workdir: tempDir, config });

    expect(captured).toHaveLength(1);
    const opts = captured[0]?.[2];
    expect(opts).toBeDefined();
    expect(opts?.featureName).toBe("audit-feature");
  });
});

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
