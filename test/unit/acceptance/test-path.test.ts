import { describe, expect, test } from "bun:test";
import {
  groupStoriesByPackage,
  resolveSuggestedPackageFeatureTestPath,
  resolveSuggestedTestFile,
  suggestedTestFilename,
} from "../../../src/acceptance/test-path";
import type { PRD, UserStory } from "../../../src/prd";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeStory(id: string, workdir?: string, status: UserStory["status"] = "pending"): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "",
    acceptanceCriteria: [`AC-1 for ${id}`],
    tags: [],
    dependencies: [],
    status,
    passes: false,
    escalations: [],
    attempts: 0,
    workdir,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "proj",
    feature: "my-feature",
    branchName: "feat/my-feature",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

const WORKDIR = "/repo";

// ─── groupStoriesByPackage ───────────────────────────────────────────────────

describe("groupStoriesByPackage()", () => {
  test("single workdir — one group with correct testPath", () => {
    const prd = makePRD([makeStory("US-001", "apps/api"), makeStory("US-002", "apps/api")]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].packageDir).toBe("/repo/apps/api");
    expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/.nax-acceptance.test.ts");
    expect(groups[0].stories.map((s) => s.id)).toEqual(["US-001", "US-002"]);
  });

  test("multiple workdirs (monorepo) — one group per unique workdir", () => {
    const prd = makePRD([
      makeStory("US-001", "apps/api"),
      makeStory("US-002", "apps/cli"),
      makeStory("US-003", "apps/api"),
    ]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(2);
    const dirs = groups.map((g) => g.packageDir).sort();
    expect(dirs).toEqual(["/repo/apps/api", "/repo/apps/cli"]);
  });

  test("stories with no workdir are grouped at repo root", () => {
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].packageDir).toBe(WORKDIR);
    expect(groups[0].testPath).toBe("/repo/.nax/features/my-feature/.nax-acceptance.test.ts");
  });

  test("empty PRD — fallback to one root group", () => {
    const prd = makePRD([]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].packageDir).toBe(WORKDIR);
    expect(groups[0].stories).toHaveLength(0);
  });

  test("fix stories (US-FIX-*) are excluded", () => {
    const prd = makePRD([makeStory("US-001", "apps/api"), makeStory("US-FIX-001", "apps/api")]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].stories.map((s) => s.id)).toEqual(["US-001"]);
  });

  test("decomposed stories are excluded", () => {
    const prd = makePRD([
      makeStory("US-001", "apps/api"),
      makeStory("US-002", "apps/api", "decomposed" as UserStory["status"]),
    ]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].stories.map((s) => s.id)).toEqual(["US-001"]);
  });

  test("respects language for file extension", () => {
    const prd = makePRD([makeStory("US-001", "apps/api")]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "go");
    expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/.nax-acceptance_test.go");
  });

  test("respects testPathConfig override", () => {
    const prd = makePRD([makeStory("US-001", "apps/api")]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature", "custom.test.ts");
    expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/custom.test.ts");
  });

  test("criteria are collected per group", () => {
    const prd = makePRD([makeStory("US-001", "apps/api"), makeStory("US-002", "apps/api")]);
    const groups = groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups[0].criteria).toEqual(["AC-1 for US-001", "AC-1 for US-002"]);
  });
});

describe("suggestedTestFilename()", () => {
  test("returns .nax-suggested.test.ts for TypeScript (default)", () => {
    expect(suggestedTestFilename()).toBe(".nax-suggested.test.ts");
    expect(suggestedTestFilename("typescript")).toBe(".nax-suggested.test.ts");
  });

  test("returns .nax-suggested_test.go for Go", () => {
    expect(suggestedTestFilename("go")).toBe(".nax-suggested_test.go");
  });

  test("returns .nax-suggested.test.py for Python", () => {
    expect(suggestedTestFilename("python")).toBe(".nax-suggested.test.py");
  });

  test("returns .nax-suggested.rs for Rust", () => {
    expect(suggestedTestFilename("rust")).toBe(".nax-suggested.rs");
  });
});

describe("resolveSuggestedTestFile()", () => {
  test("uses config override when provided", () => {
    expect(resolveSuggestedTestFile("go", "custom-suggested.test.ts")).toBe("custom-suggested.test.ts");
  });

  test("falls back to language default when no config override", () => {
    expect(resolveSuggestedTestFile("go")).toBe(".nax-suggested_test.go");
    expect(resolveSuggestedTestFile()).toBe(".nax-suggested.test.ts");
  });
});

describe("resolveSuggestedPackageFeatureTestPath()", () => {
  test("returns correct monorepo path", () => {
    const result = resolveSuggestedPackageFeatureTestPath("/project/apps/api", "auth-feature");
    expect(result).toBe("/project/apps/api/.nax/features/auth-feature/.nax-suggested.test.ts");
  });

  test("respects language", () => {
    const result = resolveSuggestedPackageFeatureTestPath("/project", "feat", undefined, "go");
    expect(result).toBe("/project/.nax/features/feat/.nax-suggested_test.go");
  });

  test("respects config override", () => {
    const result = resolveSuggestedPackageFeatureTestPath("/project", "feat", "custom.test.ts");
    expect(result).toBe("/project/.nax/features/feat/custom.test.ts");
  });
});
