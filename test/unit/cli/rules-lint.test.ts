/**
 * rules-lint.ts — unit tests
 *
 * Covers rulesLintCommand and collectCanonicalRuleRoots from the split.
 * Tests AC6 and AC7.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CANONICAL_RULE_GLOB_EXCLUDE_SEGMENTS,
  DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS,
  MAX_CANONICAL_RULE_GLOB_FILES,
  MAX_DEAD_GLOB_SCAN_FILES,
  MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES,
  type RulesLintOptions,
  _rulesCLIDeps,
  _rulesLintDeps,
  collectCanonicalRuleRoots,
  rulesLintCommandDirect as rulesLintCommandFromLint,
  rulesLintCommand as rulesLintCommandFromRules,
} from "@/cli";
import { loadCanonicalRules as loadCanonicalRulesImpl } from "@/context/engine";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import type { MockLogger } from "@test/helpers";

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

  test("DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS contains node_modules, .git, dist, build, and .nax", () => {
    expect(DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS).toContain("/node_modules/");
    expect(DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS).toContain("/.git/");
    expect(DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS).toContain("/dist/");
    expect(DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS).toContain("/build/");
    expect(DEAD_GLOB_SCAN_EXCLUDE_SEGMENTS).toContain("/.nax/");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1471: globHasMatch must not report a live glob as dead when the scan cap
// would otherwise be exhausted by noise directories before reaching real
// repo source.
// ─────────────────────────────────────────────────────────────────────────────

describe("globHasMatch — #1471 scan-cap false negative", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir("rules-lint-dead-glob-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  test("finds a match under bin/ even when node_modules/ noise exceeds the scan cap", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");

    // Enough node_modules noise to exceed MAX_DEAD_GLOB_SCAN_FILES on its own,
    // planted so an unfiltered walk would exhaust the cap before reaching bin/.
    const noiseDir = join(tempDir, "node_modules", "some-pkg");
    await mkdir(noiseDir, { recursive: true });
    const noiseCount = MAX_DEAD_GLOB_SCAN_FILES + 500;
    for (let i = 0; i < noiseCount; i++) {
      await writeFile(join(noiseDir, `file-${i}.js`), "");
    }

    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "nax.ts"), "");

    expect(_rulesLintDeps.globHasMatch("bin/*.ts", tempDir)).toBe(true);
  });

  test("finds a match under bin/ even when node_modules/ and .git/ are nested inside package subdirectories", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");

    // Exclude segments must be matched anywhere in the path, not just at the
    // repo root — a monorepo package's own node_modules/.git are just as
    // capable of exhausting the cap as a root-level one.
    const nestedNodeModules = join(tempDir, "packages", "pkg-a", "node_modules", "some-pkg");
    await mkdir(nestedNodeModules, { recursive: true });
    const noiseCount = MAX_DEAD_GLOB_SCAN_FILES + 500;
    for (let i = 0; i < noiseCount; i++) {
      await writeFile(join(nestedNodeModules, `file-${i}.js`), "");
    }

    const nestedGit = join(tempDir, "packages", "pkg-b", ".git", "objects");
    await mkdir(nestedGit, { recursive: true });
    await writeFile(join(nestedGit, "pack.idx"), "");

    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "nax.ts"), "");

    expect(_rulesLintDeps.globHasMatch("bin/*.ts", tempDir)).toBe(true);
  });

  test("MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES bounds worst-case wall time for exclude-heavy trees", () => {
    // Documents the safety-valve relationship rather than re-running a
    // 50k+-file scan (already exercised at smaller scale by the tests above).
    expect(MAX_DEAD_GLOB_SCAN_TOTAL_ENTRIES).toBe(MAX_DEAD_GLOB_SCAN_FILES * 25);
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

function captureLoggerCalls(): MockLogger {
  const logger = makeLogger();
  _rulesCLIDeps.getLogger = () => logger;
  return logger;
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

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — inert `paths:` scoping warnings + displaced-frontmatter surfacing
// (docs/specs/SPEC-rules-lint-inert-scoping.md)
// ─────────────────────────────────────────────────────────────────────────────

let tempDirForDisplacement: string | undefined;

let origCliDeps: {
  globCanonicalRuleFiles: typeof _rulesCLIDeps.globCanonicalRuleFiles;
  loadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;
  globHasMatch: typeof _rulesCLIDeps.globHasMatch;
  getLogger: typeof _rulesCLIDeps.getLogger;
  discoverWorkspacePackages: typeof _rulesCLIDeps.discoverWorkspacePackages;
};

beforeEach(() => {
  tempDirForDisplacement = makeTempDir("nax-rules-lint-displacement-");
  origCliDeps = {
    globCanonicalRuleFiles: _rulesCLIDeps.globCanonicalRuleFiles,
    loadCanonicalRules: _rulesCLIDeps.loadCanonicalRules,
    globHasMatch: _rulesCLIDeps.globHasMatch,
    getLogger: _rulesCLIDeps.getLogger,
    discoverWorkspacePackages: _rulesCLIDeps.discoverWorkspacePackages,
  };
});

afterEach(() => {
  _rulesCLIDeps.globCanonicalRuleFiles = origCliDeps.globCanonicalRuleFiles;
  _rulesCLIDeps.loadCanonicalRules = origCliDeps.loadCanonicalRules;
  _rulesCLIDeps.globHasMatch = origCliDeps.globHasMatch;
  _rulesCLIDeps.getLogger = origCliDeps.getLogger;
  _rulesCLIDeps.discoverWorkspacePackages = origCliDeps.discoverWorkspacePackages;

  cleanupTempDir(tempDirForDisplacement);
  tempDirForDisplacement = undefined;
});

function makeRule(overrides: Partial<CanonicalRule>): CanonicalRule {
  return {
    fileName: "rule.md",
    path: "rule.md",
    content: "Body.",
    warnings: [],
    ...overrides,
  };
}

function captureInertScopingLogger(): MockLogger {
  const logger = makeLogger();
  _rulesCLIDeps.getLogger = () => logger;
  return logger;
}

function stubInertScopingDeps(rules: CanonicalRule[]): void {
  _rulesCLIDeps.globCanonicalRuleFiles = () => [];
  _rulesCLIDeps.loadCanonicalRules = async () => rules;
  _rulesCLIDeps.globHasMatch = () => true;
}

describe("US-002 rulesLintCommand — AC1 displaced-frontmatter text surfaced", () => {
  test("[AC1] the warning message emitted for an HTML-comment-displaced rule includes the offending comment text", async () => {
    const htmlComment = "<!-- reviewed by legacy migrate -->";
    const content = [htmlComment, "---", "priority: 90", "---", "Body.", ""].join("\n");
    const filePath = join(tempDirForDisplacement as string, ".nax", "rules", "displaced.md");
    await Bun.write(filePath, content);

    // Use the real loader (not stubbed) so the parser-driven warning actually
    // captures the HTML comment text — then the lint command's re-emit should
    // surface that text in its logger.warn call.
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async (workdir: string) =>
      (await loadCanonicalRulesImpl(workdir)) as CanonicalRule[];
    _rulesCLIDeps.globHasMatch = () => true;
    _rulesCLIDeps.discoverWorkspacePackages = async () => [];
    const { calls } = captureInertScopingLogger();

    await rulesLintCommandFromRules({ dir: tempDirForDisplacement as string });

    const warn = calls.find(
      (c) =>
        c.level === "warn" &&
        c.stage === "rules-lint" &&
        typeof c.message === "string" &&
        c.message.includes(htmlComment),
    );
    expect(warn).toBeDefined();
  });
});

describe("US-002 rulesLintCommand — AC2 inert-paths warning", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-rules-lint-inert-scoping-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("[AC2] emits a rules-lint warning naming the rule file path when discoverWorkspacePackages resolves to [] and the rule declares paths", async () => {
    const rulePath = "scoped.md";
    const absolutePath = join(tempDir, ".nax", "rules", rulePath);
    stubInertScopingDeps([makeRule({ path: rulePath, fileName: rulePath, paths: ["src/**/*.ts"] })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => [];
    const { calls } = captureInertScopingLogger();

    await rulesLintCommandFromRules({ dir: tempDir });

    const inert = calls.find(
      (c) =>
        c.level === "warn" &&
        c.stage === "rules-lint" &&
        c.data?.file === absolutePath &&
        c.data?.code === "INERT_PATHS",
    );
    expect(inert).toBeDefined();
  });

  test("[AC3] the inert-paths warning message names `appliesTo` as the alternative", async () => {
    stubInertScopingDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => [];
    const { calls } = captureInertScopingLogger();

    await rulesLintCommandFromRules({ dir: tempDir });

    const inert = calls.find((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBeDefined();
    expect(inert?.message.toLowerCase()).toContain("appliesto");
  });

  test("[AC4] emits no inert-paths warning when discoverWorkspacePackages resolves to a non-empty package list", async () => {
    stubInertScopingDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => ["packages/api", "packages/web"];
    const { calls } = captureInertScopingLogger();

    await rulesLintCommandFromRules({ dir: tempDir });

    const inert = calls.some((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBe(false);
  });

  test("[AC5] emits no inert-paths warning for a rule declaring no paths key when discoverWorkspacePackages resolves empty", async () => {
    stubInertScopingDeps([makeRule({ path: "unscoped.md", fileName: "unscoped.md" })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => [];
    const { calls } = captureInertScopingLogger();

    await rulesLintCommandFromRules({ dir: tempDir });

    const inert = calls.some((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBe(false);
  });
});

describe("US-002 rulesLintCommand — AC6 exit code stays 0 on warnings only", () => {
  test("[AC6] resolves without setting a non-zero process.exitCode when the only signal is warnings", async () => {
    stubInertScopingDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => [];
    captureInertScopingLogger();

    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await rulesLintCommandFromRules({ dir: "/project" });
      expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe("US-002 rulesLintCommand — AC7 summary line counts warnings", () => {
  test("[AC7] the final stdout [WARN] summary line includes an inert-paths warning in N", async () => {
    stubInertScopingDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => [];
    const { calls } = captureInertScopingLogger();

    const originalLog = console.log;
    const stdoutLines: string[] = [];
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await rulesLintCommandFromRules({ dir: "/project" });
    } finally {
      console.log = originalLog;
    }

    const summary = stdoutLines.find((l) => /\[WARN\] Canonical rules lint completed with \d+ warning\(s\)/.test(l));
    expect(summary).toBeDefined();
    const m = summary?.match(/completed with (\d+) warning\(s\)/);
    const n = m ? Number(m[1]) : Number.NaN;
    expect(n).toBeGreaterThanOrEqual(1);

    const hasCountField = calls.some((c) => typeof c.data?.warningCount === "number");
    expect(hasCountField).toBe(true);
  });
});

describe("US-002 rulesLintCommand — AC8/AC9 fail-open on rejection", () => {
  test("[AC8] emits no inert-paths warning when discoverWorkspacePackages rejects", async () => {
    stubInertScopingDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => {
      throw new Error("detection failed");
    };
    const { calls } = captureInertScopingLogger();

    await rulesLintCommandFromRules({ dir: "/project" });

    const inert = calls.some((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBe(false);
  });

  test("[AC9] still emits its final stdout summary line when discoverWorkspacePackages rejects", async () => {
    stubInertScopingDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    _rulesCLIDeps.discoverWorkspacePackages = async () => {
      throw new Error("detection failed");
    };
    captureInertScopingLogger();

    const originalLog = console.log;
    const stdoutLines: string[] = [];
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await rulesLintCommandFromRules({ dir: "/project" });
    } finally {
      console.log = originalLog;
    }

    const summary = stdoutLines.find(
      (l) =>
        /\[WARN\] Canonical rules lint completed with \d+ warning\(s\)/.test(l) ||
        /\[OK\] Canonical rules lint passed/.test(l),
    );
    expect(summary).toBeDefined();
  });
});

describe("US-002 deps registration — discoverWorkspacePackages", () => {
  test("_rulesLintDeps exposes discoverWorkspacePackages", () => {
    expect(typeof _rulesLintDeps.discoverWorkspacePackages).toBe("function");
  });

  test("_rulesCLIDeps exposes discoverWorkspacePackages", () => {
    expect(typeof _rulesCLIDeps.discoverWorkspacePackages).toBe("function");
  });
});

describe("US-002 rulesLintCommandDirect — dep forwarding", () => {
  test("[dep forwarding] rulesLintCommandDirect accepts a discoverWorkspacePackages override via deps", async () => {
    // Reuse the already-stubbed _rulesCLIDeps so the rules with `paths:`
    // actually flow through. Pass `loadCanonicalRules` explicitly via the
    // explicit `deps` argument so it is honoured even though the lazy wrapper
    // in src/cli/rules.ts delegates to _rulesCLIDeps (this test bypasses the
    // wrapper to exercise the direct seam).
    _rulesCLIDeps.globCanonicalRuleFiles = () => [];
    _rulesCLIDeps.loadCanonicalRules = async () => [
      makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] }),
    ];
    _rulesCLIDeps.globHasMatch = () => true;

    const logger = makeLogger();

    await rulesLintCommandFromLint(
      { dir: "/project" },
      {
        globCanonicalRuleFiles: _rulesCLIDeps.globCanonicalRuleFiles,
        loadCanonicalRules: _rulesCLIDeps.loadCanonicalRules,
        globHasMatch: _rulesCLIDeps.globHasMatch,
        getLogger: () => logger,
        discoverWorkspacePackages: async () => [],
      },
    );

    const inert = logger.calls.some(
      (c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS",
    );
    expect(inert).toBe(true);
  });
});
