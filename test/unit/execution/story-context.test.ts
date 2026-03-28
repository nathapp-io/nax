/**
 * Unit tests for buildStoryContextFull — package-level context.md loading (MW-003)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import { buildStoryContextFull } from "../../../src/execution/story-context";
import type { PRD, UserStory } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

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

function makeConfig(): NaxConfig {
  return {
    autoMode: { defaultAgent: "claude" },
    execution: { sessionTimeoutSeconds: 30, verificationTimeoutSeconds: 60 },
    models: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
    quality: { requireTests: false, commands: {} },
    // Disable test coverage scanning — prevents buildContext from scanning the
    // entire nax repo (286 test files) on every test, which was adding 4–7s each.
    context: { testCoverage: { enabled: false } },
  } as unknown as NaxConfig;
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
    const result = await buildStoryContextFull(prd, story, makeConfig());
    // PRD context contains story elements — result is defined
    expect(result).not.toBeUndefined();
    expect(result?.markdown).not.toContain("---");
  });

  test("appends package context.md when packageWorkdir is set and file exists", async () => {
    // Create <tmpDir>/.nax/context.md
    await Bun.write(join(tmpDir, ".nax", "context.md"), "# Package Context\n\nPackage-specific content.");

    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContextFull(prd, story, makeConfig(), tmpDir);

    // Should include the package context.md content
    expect(result).not.toBeUndefined();
    expect(result?.markdown).toContain("Package Context");
    expect(result?.markdown).toContain("Package-specific content.");
  });

  test("does not add package separator when nax/context.md does not exist", async () => {
    // tmpDir has no nax/context.md
    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContextFull(prd, story, makeConfig(), tmpDir);
    // PRD context still present, but no package section appended
    expect(result).not.toBeUndefined();
    expect(result?.markdown).not.toContain("---");
  });

  test("separates root context and package context with ---", async () => {
    await Bun.write(join(tmpDir, ".nax", "context.md"), "# Package Context\nstuff");

    const story = makeStory();
    const prd = makePrd(story);
    const result = await buildStoryContextFull(prd, story, makeConfig(), tmpDir);

    expect(result?.markdown).toContain("---");
    expect(result?.markdown).toContain("# Package Context");
  });
});
