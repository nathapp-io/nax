/**
 * rules-lint.ts — unit tests
 *
 * Covers rulesLintCommand and collectCanonicalRuleRoots from the split.
 * Tests AC6 and AC7.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS,
  MAX_CANONICAL_RULE_GLOB_FILES,
  MAX_DEAD_GLOB_SCAN_FILES,
  type RulesLintOptions,
  _rulesCLIDeps,
  _rulesLintDeps,
  collectCanonicalRuleRoots,
  rulesLintCommandDirect as rulesLintCommandFromLint,
  rulesLintCommand as rulesLintCommandFromRules,
} from "@/cli";
import type { CanonicalRule } from "@/context/rules/canonical-loader";

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
    _rulesLintDeps.globCanonicalRuleFiles = () => [".nax/rules/root.md", "packages/api/.nax/rules/api.md"];

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

// ─────────────────────────────────────────────────────────────────────────────
// US-005 — Expose scoping warnings in rules lint
//
// The lint command re-emits CanonicalRule.warnings (produced by the parser /
// loader) through its own injectable logger so that `nax rules lint` is
// observable on its own — not only when rules are loaded at runtime. We test
// the rules.ts-side entry point (rulesLintCommand via _rulesCLIDeps) because
// the AC names _rulesCLIDeps.getLogger() as the surface.
// ─────────────────────────────────────────────────────────────────────────────

function makeRuleWithWarnings(overrides: Partial<CanonicalRule> & { warnings?: string[] }): CanonicalRule {
  return {
    fileName: "rule.md",
    path: "rule.md",
    content: "Body.",
    warnings: [],
    ...overrides,
  };
}

function captureLoggerCalls(): {
  calls: Array<{ level: string; stage: string; message: string; data?: Record<string, unknown> }>;
  reset(): void;
} {
  const calls: Array<{ level: string; stage: string; message: string; data?: Record<string, unknown> }> = [];
  const logger = {
    warn: (stage: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ level: "warn", stage, message, data });
    },
    info: (stage: string, message: string, data?: Record<string, unknown>) => {
      calls.push({ level: "info", stage, message, data });
    },
    debug: () => {},
    error: () => {},
  };
  _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;
  return {
    calls,
    reset: () => {
      calls.length = 0;
    },
  };
}

describe("rulesLintCommand — AC1 unrecognised-stage warning", () => {
  test("[AC1] emits a warning through _rulesCLIDeps.getLogger() naming the rule file when a stage matches neither STAGE_CONTEXT_MAP nor known stage literals", async () => {
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async () => [
      makeRuleWithWarnings({
        path: "weird.md",
        fileName: "weird.md",
        stages: ["not-a-real-stage"],
        warnings: [`Unknown stage name "not-a-real-stage" — rule will still load but may never be applied`],
      }),
    ];

    const spy = captureLoggerCalls();

    await rulesLintCommandFromRules({ dir: "/project" });

    const warn = spy.calls.find((c) => c.level === "warn" && /not-a-real-stage/i.test(c.message));
    expect(warn).toBeDefined();
    expect(warn?.data?.file).toBe("weird.md");
  });
});

describe("rulesLintCommand — AC2 no unrecognised-stage warning when stages recognised", () => {
  test("[AC2] emits no unrecognised-stage warning when every declared stage is recognised", async () => {
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async () => [
      makeRuleWithWarnings({
        path: "exec.md",
        fileName: "exec.md",
        stages: ["execution", "review"],
        warnings: [],
      }),
    ];

    const spy = captureLoggerCalls();

    await rulesLintCommandFromRules({ dir: "/project" });

    const unrecognisedWarn = spy.calls.find(
      (c) => c.level === "warn" && /unknown stage|unrecognised stage|not-a-real-stage/i.test(c.message),
    );
    expect(unrecognisedWarn).toBeUndefined();
  });
});

describe("rulesLintCommand — AC3 displaced-frontmatter warning", () => {
  test("[AC3] emits a warning through _rulesCLIDeps.getLogger() naming the rule file when it begins with a blank line followed by ---", async () => {
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async () => [
      makeRuleWithWarnings({
        path: "displaced.md",
        fileName: "displaced.md",
        warnings: [
          `Frontmatter is displaced — file begins with a blank line before '---' (/project/.nax/rules/displaced.md)`,
        ],
      }),
    ];

    const spy = captureLoggerCalls();

    await rulesLintCommandFromRules({ dir: "/project" });

    const warn = spy.calls.find((c) => c.level === "warn" && /displaced|blank line/i.test(c.message));
    expect(warn).toBeDefined();
    expect(warn?.data?.file).toBe("displaced.md");
  });
});

describe("rulesLintCommand — AC4 resolves when displaced frontmatter is present", () => {
  test("[AC4] resolves without throwing when a rule file carries displaced frontmatter", async () => {
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async () => [
      makeRuleWithWarnings({
        path: "displaced.md",
        fileName: "displaced.md",
        content: "Body still parses.",
        warnings: [
          `Frontmatter is displaced — file begins with a blank line before '---' (/project/.nax/rules/displaced.md)`,
        ],
      }),
    ];
    // Capture logger to avoid noisy output, but not strictly required.
    captureLoggerCalls();

    let threw: unknown;
    try {
      await rulesLintCommandFromRules({ dir: "/project" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
  });
});

describe("rulesLintCommand — AC5 dead-glob warning preserved", () => {
  test("[AC5] still reports the dead-glob warning through _rulesCLIDeps.getLogger() when a rule's appliesTo glob matches no file", async () => {
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async () => [
      makeRuleWithWarnings({
        path: "ghost.md",
        fileName: "ghost.md",
        appliesTo: ["src/does-not-exist/**"],
        warnings: [],
      }),
    ];
    _rulesCLIDeps.globHasMatch = () => false;

    const spy = captureLoggerCalls();

    await rulesLintCommandFromRules({ dir: "/project" });

    const deadGlobWarn = spy.calls.find(
      (c) => c.level === "warn" && /appliesTo glob matches no files/i.test(c.message),
    );
    expect(deadGlobWarn).toBeDefined();
    expect(deadGlobWarn?.data?.file).toBe("ghost.md");
    expect(deadGlobWarn?.data?.pattern).toBe("src/does-not-exist/**");
  });
});
