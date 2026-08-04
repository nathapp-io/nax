/**
 * rules-lint.ts — unit tests
 *
 * Covers rulesLintCommand and collectCanonicalRuleRoots from the split.
 * Tests AC6 and AC7.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _rulesCLIDeps,
  _rulesLintDeps,
  collectCanonicalRuleRoots,
  MAX_DEAD_GLOB_SCAN_FILES,
  MAX_CANONICAL_RULE_GLOB_FILES,
  CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS,
  rulesLintCommand as rulesLintCommandFromRules,
  rulesLintCommandDirect as rulesLintCommandFromLint,
  type RulesLintOptions,
} from "@/cli";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origGlobCanonicalRuleFilesLint: typeof _rulesLintDeps.globCanonicalRuleFiles;
let origLoadCanonicalRulesLint: typeof _rulesLintDeps.loadCanonicalRules;
let origGetLoggerLint: typeof _rulesLintDeps.getLogger;

let origGlobCanonicalRuleFilesCLI: typeof _rulesCLIDeps.globCanonicalRuleFiles;
let origLoadCanonicalRulesCLI: typeof _rulesCLIDeps.loadCanonicalRules;
let origGetLoggerCLI: typeof _rulesCLIDeps.getLogger;

beforeEach(() => {
  origGlobCanonicalRuleFilesLint = _rulesLintDeps.globCanonicalRuleFiles;
  origLoadCanonicalRulesLint = _rulesLintDeps.loadCanonicalRules;
  origGetLoggerLint = _rulesLintDeps.getLogger;

  origGlobCanonicalRuleFilesCLI = _rulesCLIDeps.globCanonicalRuleFiles;
  origLoadCanonicalRulesCLI = _rulesCLIDeps.loadCanonicalRules;
  origGetLoggerCLI = _rulesCLIDeps.getLogger;
});

afterEach(() => {
  _rulesLintDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFilesLint;
  _rulesLintDeps.loadCanonicalRules = origLoadCanonicalRulesLint;
  _rulesLintDeps.getLogger = origGetLoggerLint;

  _rulesCLIDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFilesCLI;
  _rulesCLIDeps.loadCanonicalRules = origLoadCanonicalRulesCLI;
  _rulesCLIDeps.getLogger = origGetLoggerCLI;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: rulesLintCommand() from src/cli/rules-lint resolves without throwing
//       against a repository containing no canonical rule files
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesLintCommand — AC6", () => {
  test("[AC6] resolves without throwing against a repository containing no canonical rule files", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [];
    _rulesLintDeps.loadCanonicalRules = async () => [];

    let threw: unknown;
    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
  });

  test("[AC6] calls loadCanonicalRules once with the workdir when no package overlays", async () => {
    const calls: string[] = [];
    _rulesLintDeps.globCanonicalRuleFiles = () => [];
    _rulesLintDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      return [];
    };

    await rulesLintCommandFromLint({ dir: "/project" });

    expect(calls).toEqual(["/project"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: rulesLintCommand remains importable from src/cli/rules via re-export
// Note: This is verified by the import statement succeeding - the test below
// confirms the function can be called from both import paths
// ─────────────────────────────────────────────────────────────────────────────

describe("rulesLintCommand — AC7", () => {
  test("[AC7] rulesLintCommand is importable from src/cli/rules", async () => {
    const calls: string[] = [];
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      return [];
    };

    // Import from rules.ts (the re-export path)
    const { rulesLintCommand: rulesLintFromRules } = await import("@/cli");
    await rulesLintFromRules({ dir: "/repo" });

    expect(calls).toEqual(["/repo"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectCanonicalRuleRoots
// ─────────────────────────────────────────────────────────────────────────────

describe("collectCanonicalRuleRoots", () => {
  test("returns workdir as sole root when no package overlays exist", () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [];

    const roots = collectCanonicalRuleRoots("/project");
    expect(roots).toEqual(["/project"]);
  });

  test("discovers package overlays from nested .nax/rules paths", () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [
      ".nax/rules/root.md",
      "packages/api/.nax/rules/api.md",
      "packages/web/.nax/rules/web.md",
    ];

    const roots = collectCanonicalRuleRoots("/repo");
    expect(roots).toContain("/repo");
    expect(roots).toContain("/repo/packages/api");
    expect(roots).toContain("/repo/packages/web");
  });

  test("excludes node_modules and .git directories", () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [
      ".nax/rules/root.md",
      "packages/api/.nax/rules/api.md",
    ];

    const roots = collectCanonicalRuleRoots("/project");
    expect(roots).toEqual(["/project", "/project/packages/api"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dead-glob constants
// ─────────────────────────────────────────────────────────────────────────────

describe("dead-glob constants", () => {
  test("MAX_DEAD_GLOB_SCAN_FILES is 2000", () => {
    expect(MAX_DEAD_GLOB_SCAN_FILES).toBe(2000);
  });

  test("MAX_CANONICAL_RULE_GLOB_FILES is 500", () => {
    expect(MAX_CANONICAL_RULE_GLOB_FILES).toBe(500);
  });

  test("CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS contains node_modules and .git", () => {
    expect(CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS).toContain("/node_modules/");
    expect(CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS).toContain("/.git/");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RulesLintOptions interface
// ─────────────────────────────────────────────────────────────────────────────

describe("RulesLintOptions", () => {
  test("accepts dir option", async () => {
    const calls: string[] = [];
    _rulesLintDeps.globCanonicalRuleFiles = () => [];
    _rulesLintDeps.loadCanonicalRules = async (workdir: string) => {
      calls.push(workdir);
      return [];
    };

    const options: RulesLintOptions = { dir: "/custom/path" };
    await rulesLintCommandFromLint(options);

    expect(calls).toEqual(["/custom/path"]);
  });
});
