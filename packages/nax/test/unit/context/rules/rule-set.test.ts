/**
 * rule-set — repo / package / override rule resolution (US-001).
 *
 * `resolveRuleSet` is the one resolver behind every delivery path: the
 * pipeline's `StaticRulesProvider`, the native rule-delivery handlers
 * (US-005) and the review maps (US-006). Layers are applied in order — repo
 * `.nax/rules/`, then `<pkg>/.nax/rules/`, then the override directory — and a
 * later layer replaces an earlier rule with the same rule id.
 *
 * These tests use real temp directories. The resolver's whole job is to read
 * two directory layouts and merge them, so a stubbed loader would only test the
 * merge against a fiction; `loadCanonicalRulesFromDir`'s neutrality and
 * frontmatter behaviour is covered through the canonical-loader `_deps` seam it
 * already has (AC-9, AC-16).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, makeLogger, withTempDir } from "@test/helpers";
import { _canonicalLoaderDeps, loadCanonicalRulesFromDir, NeutralityLintError } from "@/context/rules/canonical-loader";
import { resolveRuleSet, rulesForFile } from "@/context/rules/rule-set";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Write `rel -> content` under `root`, creating parent directories. */
async function seedFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(join(root, rel), content);
  }
}

const API_PACKAGE = "packages/api";
const WEB_PACKAGE = "packages/web";

/** A package needs a boundary marker for `findPackageDir` (AC-11/AC-12). */
async function makePackage(root: string, packageRel: string): Promise<void> {
  await seedFiles(root, { [`${packageRel}/package.json`]: `{"name":"${packageRel}"}` });
}

// ─────────────────────────────────────────────────────────────────────────────
// Repo layer
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveRuleSet — repo layer", () => {
  test("AC-1: resolves a repo rule with its ruleId, source 'repo' and a .nax/rules display path", async () => {
    await withTempDir(async (repoRoot) => {
      await seedFiles(repoRoot, { ".nax/rules/a.md": "## A\n\nREPO-A" });

      const set = await resolveRuleSet({ repoRoot, packageDir: repoRoot });

      expect(set.rules).toHaveLength(1);
      const rule = set.rules[0];
      assertDefined(rule, "resolved rule");
      expect(rule.ruleId).toBe("a");
      expect(rule.source).toBe("repo");
      expect(rule.displayPath).toBe(".nax/rules/a.md");
    });
  });

  test("AC-3: a repo rule whose paths: excludes the story's package is dropped but still counted", async () => {
    await withTempDir(async (repoRoot) => {
      await seedFiles(repoRoot, {
        ".nax/rules/web.md": "---\npaths:\n  - packages/web/*\n---\n\nWEB-BODY",
      });

      const set = await resolveRuleSet({
        repoRoot,
        packageDir: join(repoRoot, API_PACKAGE),
        storyWorkdir: API_PACKAGE,
      });

      expect(set.rules).toHaveLength(0);
      expect(set.repoRulesTotal).toBe(1);
      expect(set.repoRulesMatchedPaths).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Package layer
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveRuleSet — package layer", () => {
  test("AC-2: a package rule with the same rule id replaces the repo rule", async () => {
    await withTempDir(async (repoRoot) => {
      await seedFiles(repoRoot, {
        ".nax/rules/x.md": "## X\n\nREPO-X",
        [`${API_PACKAGE}/.nax/rules/x.md`]: "## X\n\nPACKAGE-X",
      });

      const set = await resolveRuleSet({
        repoRoot,
        packageDir: join(repoRoot, API_PACKAGE),
        storyWorkdir: API_PACKAGE,
      });

      expect(set.rules).toHaveLength(1);
      const rule = set.rules[0];
      assertDefined(rule, "resolved rule");
      expect(rule.ruleId).toBe("x");
      expect(rule.source).toBe("package");
      expect(rule.content).toContain("PACKAGE-X");
      expect(set.packageRulesCount).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Override layer
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveRuleSet — override layer", () => {
  test("AC-4: a merged override rule carries source 'override' and its absolute display path", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await seedFiles(overrideDir, { "org.md": "## Org\n\nORG-BODY" });

        const set = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir, overrideMode: "merge" });

        const rule = set.rules.find((r) => r.ruleId === "org");
        assertDefined(rule, "override rule");
        expect(rule.source).toBe("override");
        expect(rule.displayPath).toBe(join(overrideDir, "org.md"));
      });
    });
  });

  test("AC-5: an override rule replaces a same-id repo rule in merge mode", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await seedFiles(repoRoot, { ".nax/rules/a.md": "## A\n\nREPO-A" });
        await seedFiles(overrideDir, { "a.md": "## A\n\nOVERRIDE-A" });

        const set = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir, overrideMode: "merge" });

        expect(set.rules).toHaveLength(1);
        const rule = set.rules[0];
        assertDefined(rule, "resolved rule");
        expect(rule.ruleId).toBe("a");
        expect(rule.source).toBe("override");
        expect(rule.content).toContain("OVERRIDE-A");
      });
    });
  });

  test("AC-6: replace mode returns only the override directory's rules", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await seedFiles(repoRoot, { ".nax/rules/a.md": "## A\n\nREPO-A" });
        await seedFiles(overrideDir, { "org.md": "## Org\n\nORG-BODY" });

        const set = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir, overrideMode: "replace" });

        expect(set.rules.map((r) => r.ruleId)).toEqual(["org"]);
        expect(set.rules[0]?.source).toBe("override");
        // The repo layer is not loaded at all in replace mode, so the counts
        // the #558 "none apply" branch reads stay at zero (it cannot fire).
        expect(set.repoRulesTotal).toBe(0);
        expect(set.repoRulesMatchedPaths).toBe(0);
        expect(set.packageRulesCount).toBe(0);
      });
    });
  });

  test("AC-6: replace mode never calls the repo/package loader", async () => {
    const repoWorkdirs: string[] = [];
    const set = await resolveRuleSet(
      {
        repoRoot: "/repo",
        packageDir: "/repo/packages/api",
        storyWorkdir: API_PACKAGE,
        overrideDir: "/override",
        overrideMode: "replace",
      },
      {
        loadRepoRules: async (workdir: string) => {
          repoWorkdirs.push(workdir);
          return [{ fileName: "repo.md", content: "REPO-BODY" }];
        },
        loadDirRules: async () => [{ fileName: "org.md", content: "ORG-BODY" }],
      },
    );

    expect(repoWorkdirs).toEqual([]);
    expect(set.rules.map((r) => r.ruleId)).toEqual(["org"]);
  });

  test("AC-7: an override rule whose paths: excludes the story's package is dropped", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await seedFiles(overrideDir, {
          "web.md": "---\npaths:\n  - packages/web/*\n---\n\nWEB-BODY",
          "any.md": "## Any\n\nANY-BODY",
        });

        const set = await resolveRuleSet({
          repoRoot,
          packageDir: join(repoRoot, API_PACKAGE),
          storyWorkdir: API_PACKAGE,
          overrideDir,
        });

        expect(set.rules.map((r) => r.ruleId)).toEqual(["any"]);
      });
    });
  });

  test("AC-8: two override dirs resolve independently", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (firstDir) => {
        await withTempDir(async (secondDir) => {
          await seedFiles(firstDir, { "first.md": "FIRST-BODY" });
          await seedFiles(secondDir, { "second.md": "SECOND-BODY" });

          const first = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir: firstDir });
          const second = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir: secondDir });

          expect(first.rules.map((r) => r.ruleId)).toEqual(["first"]);
          expect(second.rules.map((r) => r.ruleId)).toEqual(["second"]);
        });
      });
    });
  });

  test("AC-10: an override file with invalid frontmatter is absent while its valid sibling loads", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await seedFiles(overrideDir, {
          "broken.md": "---\npriority: not-a-number\n---\n\nBROKEN-BODY",
          "org.md": "## Org\n\nORG-BODY",
        });

        const set = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir });

        expect(set.rules.map((r) => r.ruleId)).toEqual(["org"]);
        expect(set.rules[0]?.content).toContain("ORG-BODY");
      });
    });
  });

  // B2: the relative path of a rule file is derived from the configured
  // directory, so a spelling the glob's own `join` normalizes away — most
  // commonly a trailing separator — must not cost a nested rule its path.
  test.each([
    ["a trailing separator", (dir: string) => `${dir}/`],
    ["a doubled trailing separator", (dir: string) => `${dir}//`],
    ["a trailing './' segment", (dir: string) => `${dir}/./`],
  ])("AC-4: nested override rules keep their relative paths with %s", async (_label, respell) => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await seedFiles(overrideDir, {
          "a/shared.md": "## Shared\n\nA-BODY",
          "b/shared.md": "## Shared\n\nB-BODY",
        });

        const set = await resolveRuleSet({
          repoRoot,
          packageDir: repoRoot,
          overrideDir: respell(overrideDir),
        });

        // Both survive as distinct rules, each naming its own file.
        expect(set.rules.map((r) => r.ruleId)).toEqual(["a/shared", "b/shared"]);
        expect(set.rules.map((r) => r.content)).toEqual(["## Shared\n\nA-BODY", "## Shared\n\nB-BODY"]);
        expect(set.rules.map((r) => r.displayPath)).toEqual([
          join(overrideDir, "a/shared.md"),
          join(overrideDir, "b/shared.md"),
        ]);
      });
    });
  });

  test("AC-4: the equivalent spellings of one override directory resolve to the same rules", async () => {
    await withTempDir(async (repoRoot) => {
      await withTempDir(async (overrideDir) => {
        await seedFiles(overrideDir, { "a/shared.md": "## Shared\n\nA-BODY" });

        const plain = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir });
        const respelled = await resolveRuleSet({ repoRoot, packageDir: repoRoot, overrideDir: `${overrideDir}//.` });

        expect(respelled.rules).toEqual(plain.rules);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rulesForFile
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesForFile — file governance", () => {
  test("AC-11: a rule with no appliesTo governs every file; a non-matching glob does not", async () => {
    await withTempDir(async (repoRoot) => {
      await makePackage(repoRoot, API_PACKAGE);
      await seedFiles(repoRoot, {
        ".nax/rules/always.md": "## Always\n\nALWAYS-BODY",
        ".nax/rules/web.md": "---\nappliesTo:\n  - packages/web/**/*.ts\n---\n\nWEB-BODY",
      });

      const rules = await rulesForFile({ repoRoot, path: `${API_PACKAGE}/src/x.ts` });

      expect(rules.map((r) => r.ruleId)).toEqual(["always"]);
    });
  });

  test("AC-12: a package rule governs only files inside that package", async () => {
    await withTempDir(async (repoRoot) => {
      await makePackage(repoRoot, API_PACKAGE);
      await makePackage(repoRoot, WEB_PACKAGE);
      await seedFiles(repoRoot, { [`${API_PACKAGE}/.nax/rules/p.md`]: "## P\n\nP-BODY" });

      const insideApi = await rulesForFile({ repoRoot, path: `${API_PACKAGE}/src/x.ts` });
      const insideWeb = await rulesForFile({ repoRoot, path: `${WEB_PACKAGE}/src/x.ts` });

      expect(insideApi.map((r) => r.ruleId)).toEqual(["p"]);
      expect(insideApi[0]?.source).toBe("package");
      expect(insideWeb).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadCanonicalRulesFromDir
// ─────────────────────────────────────────────────────────────────────────────

describe("loadCanonicalRulesFromDir", () => {
  test("AC-9: rejects with NeutralityLintError for a banned neutrality marker", async () => {
    await withTempDir(async (dir) => {
      await seedFiles(dir, { "bad.md": "## Bad\n\nSee CLAUDE.md for details." });

      await expect(loadCanonicalRulesFromDir(dir)).rejects.toBeInstanceOf(NeutralityLintError);
    });
  });

  describe("AC-16: invalid frontmatter warning", () => {
    let origGetLogger: typeof _canonicalLoaderDeps.getLogger;
    let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
    let origReadFile: typeof _canonicalLoaderDeps.readFile;

    beforeEach(() => {
      origGetLogger = _canonicalLoaderDeps.getLogger;
      origGlobInDir = _canonicalLoaderDeps.globInDir;
      origReadFile = _canonicalLoaderDeps.readFile;
    });

    afterEach(() => {
      _canonicalLoaderDeps.getLogger = origGetLogger;
      _canonicalLoaderDeps.globInDir = origGlobInDir;
      _canonicalLoaderDeps.readFile = origReadFile;
    });

    test("warns for the offending file before skipping it", async () => {
      const dir = "/override/rules";
      const logger = makeLogger();
      _canonicalLoaderDeps.getLogger = () => logger;
      _canonicalLoaderDeps.globInDir = () => [`${dir}/broken.md`, `${dir}/org.md`];
      _canonicalLoaderDeps.readFile = async (p: string) =>
        p.endsWith("broken.md") ? "---\npriority: nope\n---\n\nBROKEN" : "## Org\n\nORG-BODY";

      const rules = await loadCanonicalRulesFromDir(dir);

      const warns = logger.calls.filter((c) => c.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.data?.file).toBe(`${dir}/broken.md`);
      expect(rules.map((r) => r.id)).toEqual(["org"]);
    });
  });
});
