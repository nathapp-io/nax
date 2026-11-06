import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { assertDefined, assertNaxError, withTempDir } from "@test/helpers";
import {
  _groupDeps,
  acceptanceTestFilename,
  findExistingAcceptanceTestPath,
  groupStoriesByPackage,
  resolveAcceptanceFeatureTestPath,
  resolveSuggestedPackageFeatureTestPath,
  resolveSuggestedTestFile,
  suggestedTestFilename,
} from "@/acceptance";
import {
  resolveAcceptancePackageFeatureTestPath,
  resolveAcceptanceTestCandidates,
  resolveAcceptanceTestFile,
} from "@/acceptance/test-path";
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
    const dirs = groups.map((g) => g.packageDir).sort(byCodePoint);
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

  describe("per-package acceptance.testPath config override", () => {
    let origDetect: typeof _groupDeps.detectLanguage;
    let origReadPkg: typeof _groupDeps.readPackageTestPath;

    beforeEach(() => {
      origDetect = _groupDeps.detectLanguage;
      origReadPkg = _groupDeps.readPackageTestPath;
      _groupDeps.detectLanguage = async () => undefined;
    });

    afterEach(() => {
      _groupDeps.detectLanguage = origDetect;
      _groupDeps.readPackageTestPath = origReadPkg;
    });

    test("per-package testPath overrides global language (apps/web with .ts override in Python-root monorepo)", async () => {
      _groupDeps.readPackageTestPath = async (_, relativeDir) =>
        relativeDir === "apps/web" ? ".nax-acceptance.test.ts" : undefined;
      const prd = makePRD([makeStory("US-001", "apps/web"), makeStory("US-002", "apps/api")]);
      const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "python");
      const web = groups.find((g) => g.packageDir.endsWith("apps/web"));
      const api = groups.find((g) => g.packageDir.endsWith("apps/api"));
      assertDefined(web, "web group");
      assertDefined(api, "api group");
      expect(web.testPath).toBe("/repo/apps/web/.nax/features/my-feature/.nax-acceptance.test.ts");
      expect(api.testPath).toBe("/repo/apps/api/.nax/features/my-feature/_nax_acceptance_test.py");
    });

    test("per-package testPath takes precedence over root-level testPathConfig", async () => {
      _groupDeps.readPackageTestPath = async () => ".nax-acceptance.test.ts";
      const prd = makePRD([makeStory("US-001", "apps/web")]);
      const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", "_nax_acceptance_test.py", "python");
      expect(groups[0].testPath).toBe("/repo/apps/web/.nax/features/my-feature/.nax-acceptance.test.ts");
    });

    test("path traversal in story.workdir is ignored — readPackageTestPath returns undefined for '..'", async () => {
      let capturedRelativeDir: string | undefined;
      _groupDeps.readPackageTestPath = async (_, relativeDir) => {
        capturedRelativeDir = relativeDir;
        return undefined;
      };
      const prd = makePRD([makeStory("US-001", "../../etc")]);
      await groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "go");
      // The production guard blocks traversal before any file I/O.
      // In tests, the mock is called but should receive the raw value and return undefined.
      expect(capturedRelativeDir).toBe("../../etc");
    });
  });

  describe("root probe argument", () => {
    let origReadPkg: typeof _groupDeps.readPackageTestPath;
    let origDetect: typeof _groupDeps.detectLanguage;

    beforeEach(() => {
      origReadPkg = _groupDeps.readPackageTestPath;
      origDetect = _groupDeps.detectLanguage;
      _groupDeps.detectLanguage = async () => undefined;
    });

    afterEach(() => {
      _groupDeps.readPackageTestPath = origReadPkg;
      _groupDeps.detectLanguage = origDetect;
    });

    test("root story probes with undefined, not '.'", async () => {
      const calls: Array<string | undefined> = [];
      _groupDeps.readPackageTestPath = async (_workdir, relativeDir) => {
        calls.push(relativeDir);
        return undefined;
      };
      const prd = makePRD([makeStory("US-001")]);
      await groupStoriesByPackage(prd, WORKDIR, "my-feature");
      expect(calls).toEqual([undefined]);
    });

    test("package story probes with its relative workdir", async () => {
      const calls: Array<string | undefined> = [];
      _groupDeps.readPackageTestPath = async (_workdir, relativeDir) => {
        calls.push(relativeDir);
        return undefined;
      };
      const prd = makePRD([makeStory("US-001", "packages/app")]);
      await groupStoriesByPackage(prd, WORKDIR, "my-feature");
      expect(calls).toEqual(["packages/app"]);
    });
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
      const api = groups.find((g) => g.packageDir.endsWith("apps/api"));
      const web = groups.find((g) => g.packageDir.endsWith("apps/web"));
      assertDefined(api, "api group");
      assertDefined(web, "web group");
      expect(api.testPath).toBe("/repo/apps/api/.nax/features/my-feature/_nax_acceptance_test.py");
      expect(web.testPath).toBe("/repo/apps/web/.nax/features/my-feature/.nax-acceptance.test.ts");
    });

    test("falls back to global language when detection returns undefined", async () => {
      _groupDeps.detectLanguage = async () => undefined;
      const prd = makePRD([makeStory("US-001", "apps/api")]);
      const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "go");
      expect(groups[0].testPath).toBe("/repo/apps/api/.nax/features/my-feature/.nax-acceptance_test.go");
      expect(groups[0].language).toBe("go");
    });

    test("group.language carries the resolved per-package language for skeleton fallback", async () => {
      _groupDeps.detectLanguage = async (dir: string) => (dir.endsWith("apps/web") ? "typescript" : undefined);
      const prd = makePRD([makeStory("US-001", "apps/web"), makeStory("US-002", "apps/api")]);
      const groups = await groupStoriesByPackage(prd, WORKDIR, "my-feature", undefined, "python");
      const web = groups.find((g) => g.packageDir.endsWith("apps/web"));
      const api = groups.find((g) => g.packageDir.endsWith("apps/api"));
      assertDefined(web, "web group");
      assertDefined(api, "api group");
      expect(web.language).toBe("typescript");
      expect(api.language).toBe("python");
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
    [
      "monorepo path",
      "/project/apps/api",
      "auth-feature",
      undefined as string | undefined,
      undefined as string | undefined,
      "/project/apps/api/.nax/features/auth-feature/.nax-suggested.test.ts",
    ],
    [
      "language",
      "/project",
      "feat",
      undefined as string | undefined,
      "go",
      "/project/.nax/features/feat/.nax-suggested_test.go",
    ],
    [
      "config override",
      "/project",
      "feat",
      "custom.test.ts",
      undefined as string | undefined,
      "/project/.nax/features/feat/custom.test.ts",
    ],
  ])("respects %s", (_label, pkg, feature, override, lang, expected) => {
    expect(resolveSuggestedPackageFeatureTestPath(pkg, feature, override, lang)).toBe(expected);
  });
});

// ─── acceptance test filenames and paths ─────────────────────────────────────

describe("acceptanceTestFilename()", () => {
  test.each([
    ["go", ".nax-acceptance_test.go"],
    ["python", "_nax_acceptance_test.py"],
    ["rust", ".nax-acceptance.rs"],
    ["typescript", ".nax-acceptance.test.ts"],
    ["GO", ".nax-acceptance_test.go"],
  ] as const)("returns the %s filename", (language, expected) => {
    expect(acceptanceTestFilename(language)).toBe(expected);
  });

  test("falls back to the TypeScript filename when no language is known", () => {
    expect(acceptanceTestFilename()).toBe(".nax-acceptance.test.ts");
  });
});

describe("resolveAcceptanceTestFile()", () => {
  test("uses the configured filename over the language default", () => {
    expect(resolveAcceptanceTestFile("go", "custom.test.ts")).toBe("custom.test.ts");
  });

  test("trims surrounding whitespace from the configured filename", () => {
    expect(resolveAcceptanceTestFile(undefined, "  custom.test.ts  ")).toBe("custom.test.ts");
  });

  test("falls back to the language default when nothing is configured", () => {
    expect(resolveAcceptanceTestFile("rust")).toBe(".nax-acceptance.rs");
  });

  test("rejects a blank configured filename", () => {
    let caught: unknown;
    try {
      resolveAcceptanceTestFile(undefined, "   ");
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught, "blank acceptance.testPath");
    expect(caught.code).toBe("TEST_FILENAME_EMPTY");
    expect(caught.message).toContain("acceptance.testPath");
  });

  test.each([
    ["a nested path", "nested/.nax-acceptance.test.ts"],
    ["a windows-style path", "nested\\.nax-acceptance.test.ts"],
  ])("rejects %s so the file always lands in the feature dir", (_label, configured) => {
    let caught: unknown;
    try {
      resolveAcceptanceTestFile(undefined, configured);
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught, "path-shaped acceptance.testPath");
    expect(caught.code).toBe("TEST_FILENAME_NOT_A_PATH");
  });

  test("rejects a traversal sequence in the configured filename", () => {
    let caught: unknown;
    try {
      resolveAcceptanceTestFile(undefined, "..escape.test.ts");
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught, "traversing acceptance.testPath");
    expect(caught.code).toBe("TEST_FILENAME_PATH_TRAVERSAL");
  });

  test("resolveSuggestedTestFile() reports its own field name on rejection", () => {
    let caught: unknown;
    try {
      resolveSuggestedTestFile(undefined, "");
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught, "blank acceptance.suggestedTestPath");
    expect(caught.message).toContain("acceptance.suggestedTestPath");
  });
});

describe("resolveAcceptanceFeatureTestPath()", () => {
  test("joins the feature dir with the language default", () => {
    expect(resolveAcceptanceFeatureTestPath("/repo/.nax/features/feat", undefined, "go")).toBe(
      "/repo/.nax/features/feat/.nax-acceptance_test.go",
    );
  });

  test("joins the feature dir with the configured filename", () => {
    expect(resolveAcceptanceFeatureTestPath("/repo/.nax/features/feat", "custom.test.ts")).toBe(
      "/repo/.nax/features/feat/custom.test.ts",
    );
  });
});

describe("resolveAcceptancePackageFeatureTestPath()", () => {
  test("anchors the file inside the package's own .nax/features dir", () => {
    expect(resolveAcceptancePackageFeatureTestPath("/repo/packages/api", "feat")).toBe(
      "/repo/packages/api/.nax/features/feat/.nax-acceptance.test.ts",
    );
  });

  test("respects the language and filename overrides", () => {
    expect(resolveAcceptancePackageFeatureTestPath("/repo/packages/api", "feat", undefined, "python")).toBe(
      "/repo/packages/api/.nax/features/feat/_nax_acceptance_test.py",
    );
    expect(resolveAcceptancePackageFeatureTestPath("/repo/packages/api", "feat", "custom.test.ts")).toBe(
      "/repo/packages/api/.nax/features/feat/custom.test.ts",
    );
  });
});

describe("resolveAcceptanceTestCandidates()", () => {
  test("prefers precomputed per-package paths", () => {
    expect(
      resolveAcceptanceTestCandidates({
        acceptanceTestPaths: [
          { testPath: "/repo/a/.nax/features/f/.nax-acceptance.test.ts", packageDir: "/repo/a" },
          { testPath: "/repo/b/.nax/features/f/.nax-acceptance.test.ts", packageDir: "/repo/b" },
        ],
        featureDir: "/repo/.nax/features/f",
      }),
    ).toEqual(["/repo/a/.nax/features/f/.nax-acceptance.test.ts", "/repo/b/.nax/features/f/.nax-acceptance.test.ts"]);
  });

  test("falls back to the feature dir plus the resolved filename", () => {
    expect(
      resolveAcceptanceTestCandidates({
        featureDir: "/repo/.nax/features/f",
        testPathConfig: "custom.test.ts",
      }),
    ).toEqual(["/repo/.nax/features/f/custom.test.ts"]);
  });

  test("returns nothing when neither source is supplied", () => {
    expect(resolveAcceptanceTestCandidates({})).toEqual([]);
    expect(resolveAcceptanceTestCandidates({ acceptanceTestPaths: [] })).toEqual([]);
  });
});

describe("findExistingAcceptanceTestPath()", () => {
  test("returns the first candidate that exists on disk", async () => {
    await withTempDir(async (dir) => {
      const present = join(dir, "second.test.ts");
      await writeFile(present, "// present\n");
      expect(
        await findExistingAcceptanceTestPath({
          acceptanceTestPaths: [
            { testPath: join(dir, "absent.test.ts"), packageDir: dir },
            { testPath: present, packageDir: dir },
          ],
        }),
      ).toBe(present);
    });
  });

  test("returns undefined when no candidate exists", async () => {
    await withTempDir(async (dir) => {
      expect(
        await findExistingAcceptanceTestPath({
          acceptanceTestPaths: [{ testPath: join(dir, "absent.test.ts"), packageDir: dir }],
        }),
      ).toBeUndefined();
    });
  });

  test("returns undefined when there are no candidates at all", async () => {
    expect(await findExistingAcceptanceTestPath({})).toBeUndefined();
  });

  test("finds the language-default file inside a feature dir", async () => {
    await withTempDir(async (dir) => {
      const featureDir = join(dir, "feature");
      await mkdir(featureDir, { recursive: true });
      await writeFile(join(featureDir, ".nax-acceptance.test.ts"), "// generated\n");
      expect(await findExistingAcceptanceTestPath({ featureDir })).toBe(join(featureDir, ".nax-acceptance.test.ts"));
    });
  });
});

// ─── per-package config probe (real implementation) ─────────────────────────

describe("_groupDeps.readPackageTestPath", () => {
  // Captured at load time: the describes above swap the dep out and restore it,
  // so the real implementation is only reachable through this reference.
  const readPackageTestPath = _groupDeps.readPackageTestPath;

  async function writePackageConfig(workdir: string, pkg: string, body: string): Promise<void> {
    const dir = join(workdir, ".nax", "mono", pkg);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), body);
  }

  test("returns undefined for a root-level story (no package overlay to read)", async () => {
    await withTempDir(async (workdir) => {
      expect(await readPackageTestPath(workdir, undefined)).toBeUndefined();
    });
  });

  test("refuses an absolute package dir instead of reading outside the workdir", async () => {
    await withTempDir(async (workdir) => {
      expect(await readPackageTestPath(workdir, "/etc")).toBeUndefined();
    });
  });

  test("refuses a package dir containing a traversal segment", async () => {
    await withTempDir(async (workdir) => {
      expect(await readPackageTestPath(workdir, "packages/../../etc")).toBeUndefined();
    });
  });

  test("returns undefined when the package has no .nax/mono config", async () => {
    await withTempDir(async (workdir) => {
      expect(await readPackageTestPath(workdir, "packages/api")).toBeUndefined();
    });
  });

  test("returns the package's acceptance.testPath when configured", async () => {
    await withTempDir(async (workdir) => {
      await writePackageConfig(workdir, "packages/web", JSON.stringify({ acceptance: { testPath: "pkg.test.ts" } }));
      expect(await readPackageTestPath(workdir, "packages/web")).toBe("pkg.test.ts");
    });
  });

  test("returns undefined when the package config has no acceptance block", async () => {
    await withTempDir(async (workdir) => {
      await writePackageConfig(workdir, "packages/web", JSON.stringify({ project: { name: "web" } }));
      expect(await readPackageTestPath(workdir, "packages/web")).toBeUndefined();
    });
  });

  test("returns undefined for a malformed package config instead of throwing", async () => {
    await withTempDir(async (workdir) => {
      await writePackageConfig(workdir, "packages/web", "{ not json");
      expect(await readPackageTestPath(workdir, "packages/web")).toBeUndefined();
    });
  });
});
