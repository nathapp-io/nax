import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import { formatFragments, inspectFeatureFragments, pruneFragment } from "../../../src/cli/context-fragments";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { FeatureContextProviderV2 } from "../../../src/context/engine/providers/feature-context";
import {
  deleteFragment,
  estimatedTokenCount,
  listFragmentStoryIds,
  readFragment,
  writeFragment,
} from "../../../src/context/fragments";
import { _completionDeps, completionStage } from "../../../src/pipeline/stages/completion";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { UserStory } from "../../../src/prd";
import { makeMockRuntime } from "../../../test/helpers/runtime";

const FEATURE_ID = "feature-context-fragments";
const STORY_ID = "S1";
const MAX_TOKENS = 20;
let projectDir = "";

function story(id: string, dependencies: string[] = []): UserStory {
  return {
    id,
    title: `Title for ${id}`,
    description: "Acceptance fixture",
    acceptanceCriteria: [`${id} criterion one`, `${id} criterion two`],
    tags: [],
    dependencies,
    status: "in-progress",
    passes: false,
    attempts: 0,
    escalations: [],
  };
}

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return NaxConfigSchema.parse({
    context: { v2: { enabled: true, fragments: { enabled: true }, ...overrides } },
  });
}

async function writeFeatureFile(path: string, content: string): Promise<void> {
  await mkdir(join(projectDir, ".nax", "features", FEATURE_ID), { recursive: true });
  await Bun.write(join(projectDir, ".nax", "features", FEATURE_ID, path), content);
}

async function writePrd(dependencies: Record<string, string[]>): Promise<void> {
  await writeFeatureFile(
    "prd.json",
    JSON.stringify({
      project: "acceptance",
      feature: FEATURE_ID,
      userStories: Object.entries(dependencies).map(([id, deps]) => story(id, deps)),
    }),
  );
}

async function fetchFragments(storyId: string, config = enabledConfig()) {
  const provider = new FeatureContextProviderV2(story(storyId), config);
  const result = await provider.fetch({
    storyId,
    featureId: FEATURE_ID,
    repoRoot: projectDir,
    packageDir: projectDir,
    stage: "execution",
    budgetTokens: 8_000,
    role: "implementer",
  });
  return result.chunks.filter((chunk) => chunk.storyId !== undefined);
}

function completionContext(config = enabledConfig()): PipelineContext {
  const completed = story(STORY_ID);
  return {
    config,
    rootConfig: config,
    prd: { project: "acceptance", feature: FEATURE_ID, userStories: [completed] },
    story: completed,
    stories: [completed],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: projectDir,
    projectDir,
    prdPath: join(projectDir, "prd.json"),
    agentResult: { success: true, output: "", stderr: "", exitCode: 0, rateLimited: false, estimatedCostUsd: 0 },
    hooks: {},
    storyStartTime: new Date().toISOString(),
    runtime: makeMockRuntime(),
    storyGitRef: "HEAD~1",
  } as unknown as PipelineContext;
}

const originalCompletionDeps = {
  savePRD: _completionDeps.savePRD,
  getDiffText: _completionDeps.getDiffText,
  writeFragment: _completionDeps.writeFragment,
};

beforeEach(async () => {
  projectDir = await mkdtemp("/tmp/nax-fragments-acceptance-");
});

afterEach(async () => {
  _completionDeps.savePRD = originalCompletionDeps.savePRD;
  _completionDeps.getDiffText = originalCompletionDeps.getDiffText;
  _completionDeps.writeFragment = originalCompletionDeps.writeFragment;
  await rm(projectDir, { recursive: true, force: true });
});

describe("feature-context-fragments acceptance", () => {
  test("AC-1: default fragments are disabled", () => {
    expect(NaxConfigSchema.parse({}).context.v2.fragments.enabled).toBe(false);
  });

  test("AC-2: default fragment decay is 0.6", () => {
    expect(NaxConfigSchema.parse({}).context.v2.fragments.decay).toBe(0.6);
  });

  test("AC-3: default fragment maxTokens is 400", () => {
    expect(NaxConfigSchema.parse({}).context.v2.fragments.maxTokens).toBe(400);
  });

  test("AC-4: default fragment extractor is deterministic", () => {
    expect(NaxConfigSchema.parse({}).context.v2.fragments.extractor).toBe("deterministic");
  });

  test("AC-5: invalid fragment decay throws ZodError", () => {
    expect(() => NaxConfigSchema.parse({ context: { v2: { fragments: { decay: 1.5 } } } })).toThrow(ZodError);
  });

  test("AC-6: fragment store round-trips a body", async () => {
    const body = "A durable implementation decision.";
    await writeFragment(projectDir, FEATURE_ID, STORY_ID, body, MAX_TOKENS);
    expect(await readFragment(projectDir, FEATURE_ID, STORY_ID)).toBe(body);
  });

  test("AC-7: missing fragment reads as null", async () => {
    expect(await readFragment(projectDir, FEATURE_ID, "missing")).toBeNull();
  });

  test("AC-8: fragment writes honor the token budget", async () => {
    await writeFragment(projectDir, FEATURE_ID, STORY_ID, "word ".repeat(200), MAX_TOKENS);
    const result = await readFragment(projectDir, FEATURE_ID, STORY_ID);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected writeFragment to persist a fragment");
    expect(estimatedTokenCount(result)).toBeLessThanOrEqual(MAX_TOKENS);
  });

  test("AC-9: fragment listing includes exactly stored story IDs", async () => {
    await writeFragment(projectDir, FEATURE_ID, "S1", "one", MAX_TOKENS);
    await writeFragment(projectDir, FEATURE_ID, "S2", "two", MAX_TOKENS);
    const ids = [...(await listFragmentStoryIds(projectDir, FEATURE_ID))].sort();
    expect(ids).toEqual(["S1", "S2"]);
    expect(ids).not.toContain("S3");
  });

  test("AC-10: deleting an existing fragment removes it", async () => {
    await writeFragment(projectDir, FEATURE_ID, STORY_ID, "body", MAX_TOKENS);
    await deleteFragment(projectDir, FEATURE_ID, STORY_ID);
    expect(await readFragment(projectDir, FEATURE_ID, STORY_ID)).toBeNull();
  });

  test("AC-11: deleting a missing fragment is idempotent", async () => {
    await expect(deleteFragment(projectDir, FEATURE_ID, "missing")).resolves.toBeDefined();
  });

  test("AC-12: later writes replace the prior body", async () => {
    await writeFragment(projectDir, FEATURE_ID, STORY_ID, "first", MAX_TOKENS);
    await writeFragment(projectDir, FEATURE_ID, STORY_ID, "second", MAX_TOKENS);
    expect(await readFragment(projectDir, FEATURE_ID, STORY_ID)).toBe("second");
  });

  test("AC-13: completion captures one fragment for a passing non-batch story", async () => {
    const writeSpy = mock(async () => {});
    _completionDeps.writeFragment = writeSpy;
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(async () => "");
    await completionStage.execute(completionContext());
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(projectDir, FEATURE_ID, STORY_ID, expect.any(String), 400);
  });

  test("AC-14: completion skips capture when fragments are disabled", async () => {
    const writeSpy = mock(async () => {});
    _completionDeps.writeFragment = writeSpy;
    _completionDeps.savePRD = mock(async () => {});
    await completionStage.execute(
      completionContext(NaxConfigSchema.parse({ context: { v2: { enabled: true, fragments: { enabled: false } } } })),
    );
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("AC-15: completion skips capture when v2 context is disabled", async () => {
    const writeSpy = mock(async () => {});
    _completionDeps.writeFragment = writeSpy;
    _completionDeps.savePRD = mock(async () => {});
    await completionStage.execute(
      completionContext(NaxConfigSchema.parse({ context: { v2: { enabled: false, fragments: { enabled: true } } } })),
    );
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test("AC-16: captured fragments include the story title", async () => {
    const writeSpy = mock(async () => {});
    _completionDeps.writeFragment = writeSpy;
    _completionDeps.savePRD = mock(async () => {});
    await completionStage.execute(completionContext());
    expect(writeSpy.mock.calls[0][3]).toContain("Title for S1");
  });

  test("AC-17: captured fragments include every acceptance criterion", async () => {
    const writeSpy = mock(async () => {});
    _completionDeps.writeFragment = writeSpy;
    _completionDeps.savePRD = mock(async () => {});
    await completionStage.execute(completionContext());
    const body = writeSpy.mock.calls[0][3] as string;
    expect(body).toContain("S1 criterion one");
    expect(body).toContain("S1 criterion two");
  });

  test("AC-18: captured fragments name every changed file", async () => {
    const writeSpy = mock(async () => {});
    _completionDeps.writeFragment = writeSpy;
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(
      async () => "diff --git a/src/a.ts b/src/a.ts\ndiff --git a/test/b.test.ts b/test/b.test.ts\n",
    );
    await completionStage.execute(completionContext());
    const body = writeSpy.mock.calls[0][3] as string;
    expect(body).toContain("src/a.ts");
    expect(body).toContain("test/b.test.ts");
  });

  test("AC-19: a capture failure is non-fatal", async () => {
    _completionDeps.writeFragment = mock(async () => {
      throw new Error("disk failure");
    });
    _completionDeps.savePRD = mock(async () => {});
    const ctx = completionContext();
    await expect(completionStage.execute(ctx)).resolves.toEqual({ action: "continue" });
    expect(ctx.story.status).toBe("passed");
  });

  test("AC-20: repeated completion captures the same story twice", async () => {
    const writeSpy = mock(async () => {});
    _completionDeps.writeFragment = writeSpy;
    _completionDeps.savePRD = mock(async () => {});
    const ctx = completionContext();
    await completionStage.execute(ctx);
    await completionStage.execute(ctx);
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(writeSpy.mock.calls.every((call) => call[2] === STORY_ID)).toBe(true);
  });

  test("AC-21: provider returns no fragment chunks for zero dependencies", async () => {
    await writePrd({ S1: [] });
    expect(await fetchFragments("S1")).toEqual([]);
  });

  test("AC-22: provider returns a direct dependency fragment", async () => {
    await writePrd({ S1: ["S2"], S2: [] });
    await writeFragment(projectDir, FEATURE_ID, "S2", "dependency", MAX_TOKENS);
    const chunks = await fetchFragments("S1");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: "feature", storyId: "S2", featureId: FEATURE_ID });
  });

  test("AC-23: provider returns all transitive dependencies but not requester", async () => {
    await writePrd({ S1: ["S2"], S2: ["S3"], S3: [] });
    await writeFragment(projectDir, FEATURE_ID, "S2", "two", MAX_TOKENS);
    await writeFragment(projectDir, FEATURE_ID, "S3", "three", MAX_TOKENS);
    expect((await fetchFragments("S1")).map((chunk) => chunk.storyId).sort()).toEqual(["S2", "S3"]);
  });

  test("AC-24: provider applies decay by dependency distance", async () => {
    await writePrd({ S1: ["S2"], S2: ["S3"], S3: [] });
    await writeFragment(projectDir, FEATURE_ID, "S2", "two", MAX_TOKENS);
    await writeFragment(projectDir, FEATURE_ID, "S3", "three", MAX_TOKENS);
    const chunks = await fetchFragments("S1");
    const s2 = chunks.find((chunk) => chunk.storyId === "S2");
    const s3 = chunks.find((chunk) => chunk.storyId === "S3");
    expect(s2).toBeDefined();
    expect(s3).toBeDefined();
    if (!s2 || !s3) throw new Error("Expected chunks for both transitive dependencies");
    expect(s2.rawScore).toBe(0.6);
    expect(s3.rawScore).toBeCloseTo(0.36);
    expect(s2.rawScore).toBeGreaterThan(s3.rawScore);
  });

  test("AC-25: provider uses the shortest path through a diamond", async () => {
    await writePrd({ S1: ["S2", "S3"], S2: ["S4"], S3: ["S4"], S4: [] });
    await writeFragment(projectDir, FEATURE_ID, "S4", "four", MAX_TOKENS);
    const chunks = await fetchFragments("S1");
    expect(chunks.filter((chunk) => chunk.storyId === "S4")).toHaveLength(1);
    const s4 = chunks.find((chunk) => chunk.storyId === "S4");
    expect(s4).toBeDefined();
    if (!s4) throw new Error("Expected a fragment chunk for S4");
    expect(s4.rawScore).toBeCloseTo(0.36);
  });

  test("AC-26: provider terminates cycles without duplicate stories", async () => {
    await writePrd({ S1: ["S2"], S2: ["S3"], S3: ["S1"] });
    for (const id of ["S1", "S2", "S3"]) await writeFragment(projectDir, FEATURE_ID, id, id, MAX_TOKENS);
    const chunks = await fetchFragments("S1");
    expect(new Set(chunks.map((chunk) => chunk.storyId)).size).toBe(chunks.length);
    expect(chunks.length).toBeLessThanOrEqual(3);
  });

  test("AC-27: provider scores each fragment as decay to its shortest distance", async () => {
    await writePrd({ S1: ["S2"], S2: ["S3"], S3: ["S4"], S4: [] });
    await writeFragment(projectDir, FEATURE_ID, "S4", "four", MAX_TOKENS);
    const s4 = (await fetchFragments("S1")).find((chunk) => chunk.storyId === "S4");
    expect(s4).toBeDefined();
    if (!s4) throw new Error("Expected a fragment chunk for S4");
    expect(s4.rawScore).toBeCloseTo(0.6 ** 3);
  });

  test("AC-28: a missing intermediate fragment does not halt traversal", async () => {
    await writePrd({ S1: ["S2"], S2: ["S3"], S3: [] });
    await writeFragment(projectDir, FEATURE_ID, "S3", "three", MAX_TOKENS);
    expect((await fetchFragments("S1")).map((chunk) => chunk.storyId)).toEqual(["S3"]);
  });

  test("AC-29: missing or malformed prd retains context.md but emits no fragments", async () => {
    await writeFeatureFile("context.md", "# Context\n\nA retained legacy context.md entry.");
    await writeFeatureFile("prd.json", "not json");
    const provider = new FeatureContextProviderV2(story("S1"), enabledConfig());
    const result = await provider.fetch({
      storyId: "S1",
      featureId: FEATURE_ID,
      repoRoot: projectDir,
      packageDir: projectDir,
      stage: "execution",
      budgetTokens: 8_000,
      role: "implementer",
    });
    expect(result.chunks.filter((chunk) => chunk.storyId !== undefined)).toEqual([]);
    expect(result.chunks.some((chunk) => chunk.kind === "feature" && chunk.content.includes("context.md"))).toBe(true);
  });

  test("AC-30: disabled fragments are omitted even when files exist", async () => {
    await writePrd({ S1: ["S2"], S2: [] });
    await writeFragment(projectDir, FEATURE_ID, "S2", "two", MAX_TOKENS);
    expect(
      await fetchFragments(
        "S1",
        NaxConfigSchema.parse({ context: { v2: { enabled: true, fragments: { enabled: false } } } }),
      ),
    ).toEqual([]);
  });

  test("AC-31: each returned fragment has the required RawChunk fields", async () => {
    await writePrd({ S1: ["S2"], S2: [] });
    await writeFragment(projectDir, FEATURE_ID, "S2", "two", MAX_TOKENS);
    for (const chunk of await fetchFragments("S1")) {
      expect(chunk).toMatchObject({
        kind: "feature",
        storyId: "S2",
        featureId: FEATURE_ID,
        startLine: expect.any(Number),
      });
      expect(typeof chunk.rawScore).toBe("number");
      expect(typeof chunk.content).toBe("string");
    }
  });

  test("AC-32: inspecting two fragments outputs both distinct story IDs", async () => {
    await writeFragment(projectDir, FEATURE_ID, "Story-1", "one", MAX_TOKENS);
    await writeFragment(projectDir, FEATURE_ID, "Story-2", "two", MAX_TOKENS);
    const output = await inspectFeatureFragments(projectDir, FEATURE_ID);
    expect(output).toContain("Story-1");
    expect(output).toContain("Story-2");
    expect([...output.matchAll(/Story-[12]/g)]).toHaveLength(2);
  });

  test("AC-33: inspecting no fragments succeeds and reports none found", async () => {
    await expect(inspectFeatureFragments(projectDir, FEATURE_ID)).resolves.toMatch(/no fragments found/i);
  });

  test("AC-34: inspection reports the transitive dependent closure", async () => {
    await writePrd({ S1: [], D1: ["S1"], D2: ["D1"] });
    await writeFragment(projectDir, FEATURE_ID, "S1", "source", MAX_TOKENS);
    const output = await inspectFeatureFragments(projectDir, FEATURE_ID);
    expect(output).toContain("S1");
    expect(output).toMatch(/S1.*D1.*D2/s);
  });

  test("AC-35: pruning one fragment preserves the others", async () => {
    await writeFragment(projectDir, FEATURE_ID, "story1", "one", MAX_TOKENS);
    await writeFragment(projectDir, FEATURE_ID, "story2", "two", MAX_TOKENS);
    await pruneFragment(projectDir, FEATURE_ID, "story1");
    expect(await readFragment(projectDir, FEATURE_ID, "story1")).toBeNull();
    expect(await readFragment(projectDir, FEATURE_ID, "story2")).toBe("two");
    await expect(pruneFragment(projectDir, FEATURE_ID, "story2")).resolves.toBeDefined();
  });

  test("AC-36: pruning without a story removes all fragments", async () => {
    await writeFragment(projectDir, FEATURE_ID, "story1", "one", MAX_TOKENS);
    await writeFragment(projectDir, FEATURE_ID, "story2", "two", MAX_TOKENS);
    await pruneFragment(projectDir, FEATURE_ID);
    expect(await listFragmentStoryIds(projectDir, FEATURE_ID)).toEqual([]);
    expect(await readFragment(projectDir, FEATURE_ID, "story1")).toBeNull();
    await expect(inspectFeatureFragments(projectDir, FEATURE_ID)).resolves.toMatch(/no fragments found/i);
  });

  test("AC-37: pruning an empty fragment store succeeds and reports zero removals", async () => {
    await expect(pruneFragment(projectDir, FEATURE_ID)).resolves.toMatch(/0 fragments|nothing to remove/i);
  });

  test("AC-38: formatting is deterministic and performs no file operations", () => {
    const listing = [{ storyId: "S1", dependents: ["S1", "D1"], content: "fragment" }];
    const fileSpy = spyOn(Bun, "file");
    const readSpy = spyOn(fs, "readFile");
    const writeSpy = spyOn(fs, "writeFile");
    const unlinkSpy = spyOn(fs, "unlink");
    try {
      const outputA = formatFragments(listing);
      const outputB = formatFragments(listing);
      expect(outputA).toBe(outputB);
      expect(fileSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      fileSpy.mockRestore();
      readSpy.mockRestore();
      writeSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });
});