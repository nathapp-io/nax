/**
 * Tests for ensureStoryPackageDirs — creates package directories for stories
 * whose workdir points to a not-yet-existing package (new feature on a new
 * package). Without this, agent sessions spawn with a nonexistent cwd and die
 * on launch (implementer hard-fails, acceptance-gen degrades silently).
 */

import { describe, expect, test } from "bun:test";
import { ensureStoryPackageDirs } from "@/execution";
import type { _ensurePackageDirsDeps } from "@/execution/ensure-package-dirs";
import type { PRD, UserStory } from "@/prd";

const ROOT = "/repo";

function makeStory(id: string, workdir?: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "",
    acceptanceCriteria: [],
    dependencies: [],
    status: "pending",
    ...(workdir !== undefined ? { workdir } : {}),
  } as UserStory;
}

function makePrd(stories: UserStory[]): PRD {
  return { feature: "feat", userStories: stories } as PRD;
}

function makeDeps(existing: Set<string>) {
  const created: string[] = [];
  return {
    deps: {
      exists: async (p: string) => existing.has(p),
      mkdirp: async (p: string) => {
        created.push(p);
        existing.add(p);
      },
    } satisfies typeof _ensurePackageDirsDeps,
    created,
  };
}

describe("ensureStoryPackageDirs", () => {
  test("creates the package dir when story.workdir does not exist", async () => {
    const { deps, created } = makeDeps(new Set([ROOT]));
    const prd = makePrd([makeStory("US-001", "packages/portfolio")]);

    const result = await ensureStoryPackageDirs(prd, ROOT, deps);

    expect(created).toEqual(["/repo/packages/portfolio"]);
    expect(result).toEqual(["/repo/packages/portfolio"]);
  });

  test("does not recreate an existing package dir", async () => {
    const { deps, created } = makeDeps(new Set([ROOT, "/repo/packages/core"]));
    const prd = makePrd([makeStory("US-001", "packages/core")]);

    const result = await ensureStoryPackageDirs(prd, ROOT, deps);

    expect(created).toEqual([]);
    expect(result).toEqual([]);
  });

  test("deduplicates stories sharing the same workdir", async () => {
    const { deps, created } = makeDeps(new Set([ROOT]));
    const prd = makePrd([
      makeStory("US-001", "packages/portfolio"),
      makeStory("US-002", "packages/portfolio"),
    ]);

    await ensureStoryPackageDirs(prd, ROOT, deps);

    expect(created).toEqual(["/repo/packages/portfolio"]);
  });

  test("ignores stories without a workdir (root-scoped)", async () => {
    const { deps, created } = makeDeps(new Set([ROOT]));
    const prd = makePrd([makeStory("US-001"), makeStory("US-002", "")]);

    await ensureStoryPackageDirs(prd, ROOT, deps);

    expect(created).toEqual([]);
  });

  test("creates dirs for multiple distinct new packages", async () => {
    const { deps, created } = makeDeps(new Set([ROOT, "/repo/packages/core"]));
    const prd = makePrd([
      makeStory("US-001", "packages/portfolio"),
      makeStory("US-002", "packages/core"),
      makeStory("US-003", "apps/web"),
    ]);

    const result = await ensureStoryPackageDirs(prd, ROOT, deps);

    expect(new Set(created)).toEqual(new Set(["/repo/packages/portfolio", "/repo/apps/web"]));
    expect(new Set(result)).toEqual(new Set(["/repo/packages/portfolio", "/repo/apps/web"]));
  });

  test("never escapes the repo root via traversal in workdir", async () => {
    const { deps, created } = makeDeps(new Set([ROOT]));
    const prd = makePrd([makeStory("US-001", "../evil")]);

    await ensureStoryPackageDirs(prd, ROOT, deps);

    expect(created).toEqual([]);
  });
});
