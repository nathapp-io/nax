import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _groupDeps,
  groupStoriesByPackage,
  resolveSuggestedPackageFeatureTestPath,
  resolveSuggestedTestFile,
  suggestedTestFilename,
} from "@/acceptance";
import type { PRD, UserStory } from "@/prd";

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
  test("single workdir — one group with correct testPath", async () => {
    const prd = makePRD([makeStory("US-001", "apps/api"), makeStory("US-002", "apps/api")]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].packageDir).toBe("/repo/apps/api");
    expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/.nax-acceptance.test.ts");
    expect(groups[0].stories.map((s) => s.id)).toEqual(["US-001", "US-002"]);
  });

  test("multiple workdirs (monorepo) — one group per unique workdir", async () => {
    const prd = makePRD([
      makeStory("US-001", "apps/api"),
      makeStory("US-002", "apps/cli"),
      makeStory("US-003", "apps/api"),
    ]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(2);
    const dirs = groups.map((g) => g.packageDir).sort();
    expect(dirs).toEqual(["/repo/apps/api", "/repo/apps/cli"]);
  });

  test("stories with no workdir are grouped at repo root", async () => {
    const prd = makePRD([makeStory("US-001"), makeStory("US-002")]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].packageDir).toBe(WORKDIR);
    expect(groups[0].testPath).toBe("/repo/.nax/features/my-feature/.nax-acceptance.test.ts");
  });

  test("empty PRD — fallback to one root group", async () => {
    const prd = makePRD([]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].packageDir).toBe(WORKDIR);
    expect(groups[0].stories).toHaveLength(0);
  });

  test("fix stories (US-FIX-*) are excluded", async () => {
    const prd = makePRD([makeStory("US-001", "apps/api"), makeStory("US-FIX-001", "apps/api")]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].stories.map((s) => s.id)).toEqual(["US-001"]);
  });

  test("decomposed stories are excluded", async () => {
    const prd = makePRD([
      makeStory("US-001", "apps/api"),
      makeStory("US-002", "apps/api", "decomposed" as UserStory["status"]),
    ]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups).toHaveLength(1);
    expect(groups[0].stories.map((s) => s.id)).toEqual(["US-001"]);
  });

  test("respects language for file extension", async () => {
    const prd = makePRD([makeStory("US-001", "apps/api")]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "go");
    expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/.nax-acceptance_test.go");
  });

  test("respects testPathConfig override", async () => {
    const prd = makePRD([makeStory("US-001", "apps/api")]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", "custom.test.ts");
    expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/custom.test.ts");
  });

  test("criteria are collected per group", async () => {
    const prd = makePRD([makeStory("US-001", "apps/api"), makeStory("US-002", "apps/api")]);
    const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature");
    expect(groups[0].criteria).toEqual(["AC-1 for US-001", "AC-1 for US-002"]);
  });

  describe("per-package language detection", () => {
    let origDetect: typeof _groupDeps.detectLanguage;

    beforeEach(() => {
      origDetect = _groupDeps.detectLanguage;
    });

    afterEach(() => {
      _groupDeps.detectLanguage = origDetect;
    });

    test("polyglot monorepo — detected language per package overrides global language", async () => {
      _groupDeps.detectLanguage = async (dir: string) => {
        if (dir.endsWith("apps/web")) return "typescript";
        if (dir.endsWith("apps/api")) return "python";
        return undefined;
      };
      const prd = makePRD([makeStory("US-001", "apps/api"), makeStory("US-002", "apps/web")]);
      const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "python");
      const api = groups.find((g) => g.packageDir.endsWith("apps/api"))!;
      const web = groups.find((g) => g.packageDir.endsWith("apps/web"))!;
      expect(api.testPath).toBe("/repo/apps/api/.nax/features/my-feature/_nax_acceptance_test.py");
      expect(web.testPath).toBe("/repo/apps/web/.nax/features/my-feature/.nax-acceptance.test.ts");
    });

    test("falls back to global language when detection returns undefined", async () => {
      _groupDeps.detectLanguage = async () => undefined;
      const prd = makePRD([makeStory("US-001", "apps/api")]);
      const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "go");
      expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/.nax-acceptance_test.go");
    });
  });
});

describe("suggestedTestFilename()", () => {
  test("returns .nax-suggested.test.ts for TypeScript (default)", () => {
    expect(suggestedTestFilename()).toBe(".nax-suggested.test.ts");
    expect(suggestedTestFilename("typescript")).toBe(".nax-suggested.test.ts");
  });

  test.each([
    ["go", ".nax-suggested_test.go"],
    ["python", "_nax_suggested_test.py"],
    ["rust", ".nax-suggested.rs"],
  ] as const)("returns correct filename for %s", (lang, expected) => {
    expect(suggestedTestFilename(lang)).toBe(expected);
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
  test.each([
    ["monorepo path", "/project/apps/api", "auth-feature", undefined as string | undefined, undefined as string | undefined, "/project/apps/api/.nax/features/auth-feature/.nax-suggested.test.ts"],
    ["language", "/project", "feat", undefined as string | undefined, "go", "/project/.nax/features/feat/.nax-suggested_test.go"],
    ["config override", "/project", "feat", "custom.test.ts", undefined as string | undefined, "/project/.nax/features/feat/custom.test.ts"],
  ])("respects %s", (_label, pkg, feature, override, lang, expected) => {
    expect(resolveSuggestedPackageFeatureTestPath(pkg, feature, override, lang)).toBe(expected);
  });
});
