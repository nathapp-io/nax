/**
 * Unit tests for buildStoryContextFull — package-level context.md loading (MW-003)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeNaxConfig, makeTempDir, makeTestContext } from "@test/helpers";
import {
  buildStoryContext,
  buildStoryContextFull,
  buildStoryContextFullFromCtx,
  maybeGetContext,
} from "@/execution/story-context";
import type { PRD, UserStory } from "@/prd";

function makeStory(id = "US-001"): UserStory {
  return {
    id,
    title: "Story",
    description: "desc",
    acceptanceCriteria: ["AC"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    attempts: 0,
    escalations: [],
  };
}

function makePrd(story: UserStory): PRD {
  return {
    project: "p",
    feature: "f",
    branchName: "b",
    createdAt: "",
    updatedAt: "",
    userStories: [story],
  };
}

function makeConfig() {
  return makeNaxConfig({
    execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60 },
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    quality: { commands: {} },
    context: { testCoverage: { enabled: false } },
  });
}

describe("buildStoryContextFull — package context loading (MW-003)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns result without package context when no packageWorkdir", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContextFull(prd, story, makeConfig(), tmpDir);
    // PRD context contains story elements — result is defined
    expect(result).not.toBeUndefined();
    expect(result?.markdown).not.toContain("---");
  });

  test("appends package context.md when packageWorkdir is set and file exists", async () => {
    // Create <tmpDir>/.nax/context.md
    await Bun.write(join(tmpDir, ".nax", "context.md"), "# Package Context\n\nPackage-specific content.");

    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContextFull(prd, story, makeConfig(), tmpDir, tmpDir);

    // Should include the package context.md content
    expect(result).not.toBeUndefined();
    expect(result?.markdown).toContain("Package Context");
    expect(result?.markdown).toContain("Package-specific content.");
  });

  test("does not add package separator when nax/context.md does not exist", async () => {
    // tmpDir has no nax/context.md
    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContextFull(prd, story, makeConfig(), tmpDir, tmpDir);
    // PRD context still present, but no package section appended
    expect(result).not.toBeUndefined();
    expect(result?.markdown).not.toContain("---");
  });

  test("separates root context and package context with ---", async () => {
    await Bun.write(join(tmpDir, ".nax", "context.md"), "# Package Context\nstuff");

    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContextFull(prd, story, makeConfig(), tmpDir, tmpDir);

    expect(result?.markdown).toContain("---");
    expect(result?.markdown).toContain("# Package Context");
  });

  test("returns undefined when the context builder throws (unknown story id)", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const unknownStory = makeStory("US-does-not-exist");
    const result = await buildStoryContextFull(prd, unknownStory, makeConfig(), tmpDir, tmpDir);
    expect(result).toBeUndefined();
  });
});

describe("buildStoryContextFullFromCtx — PipelineContext wrapper", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("uses ctx.workdir as packageWorkdir when the story has its own workdir, appending package context.md", async () => {
    await Bun.write(join(tmpDir, ".nax", "context.md"), "# Package Context\nfrom ctx.workdir");
    const story: UserStory = { ...makeStory(), workdir: "packages/a" };
    const prd = makePrd(story);
    const ctx = makeTestContext({ prd, story, config: makeConfig(), workdir: tmpDir });

    const result = await buildStoryContextFullFromCtx(ctx);
    expect(result).toBeDefined();
    expect(result?.markdown).toContain("Package Context");
  });

  test("omits packageWorkdir when the story has no workdir, so no package context.md is appended", async () => {
    await Bun.write(join(tmpDir, ".nax", "context.md"), "# Package Context\nshould not appear");
    const story = makeStory();
    const prd = makePrd(story);
    const ctx = makeTestContext({ prd, story, config: makeConfig(), workdir: tmpDir });

    const result = await buildStoryContextFullFromCtx(ctx);
    expect(result).toBeDefined();
    expect(result?.markdown).not.toContain("Package Context");
  });
});

describe("maybeGetContext — gate on useContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns undefined immediately when useContext is false, without building anything", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const result = await maybeGetContext(prd, story, makeConfig(), false, tmpDir);
    expect(result).toBeUndefined();
  });

  test("delegates to buildStoryContext and returns markdown when useContext is true", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const result = await maybeGetContext(prd, story, makeConfig(), true, tmpDir);
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result).toContain(story.id);
  });
});

describe("buildStoryContext — markdown-only context building", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns context markdown containing the current story", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContext(prd, story, makeConfig(), tmpDir);
    expect(result).toBeDefined();
    expect(result).toContain(story.id);
  });

  test("returns undefined when the context builder throws (unknown story id)", async () => {
    // buildContext throws `Story <id> not found in PRD` when currentStoryId
    // does not match any userStory — buildStoryContext's catch swallows it.
    const story = makeStory();
    const prd = makePrd(story);
    const unknownStory = makeStory("US-does-not-exist");
    const result = await buildStoryContext(prd, unknownStory, makeConfig(), tmpDir);
    expect(result).toBeUndefined();
  });
});
