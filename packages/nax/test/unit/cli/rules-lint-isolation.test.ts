/**
 * rules-lint.ts — per-root error isolation + empty-store warning
 *
 * Splits the new US-002 acceptance criteria out of rules-lint.test.ts so the
 * latter stays under the 800-line test-file ceiling. Each test recomposes
 * `_rulesLintDeps.loadCanonicalRules` with a per-root variant so the command
 * sees multiple roots whose fate differs. `collectCanonicalRuleRoots` is fed
 * by `globCanonicalRuleFiles`, so we control the root set there without
 * monkey-patching the collector.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LogCall } from "@test/helpers";
import { assertNaxError, makeLogger } from "@test/helpers";
import {
  _rulesCLIDeps,
  _rulesLintDeps,
  rulesExportCommand,
  rulesLintCommandDirect as rulesLintCommandFromLint,
} from "@/cli";
import type { CanonicalRule } from "@/context/rules/canonical-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origGlobCanonicalRuleFilesLint: typeof _rulesLintDeps.globCanonicalRuleFiles;
let origLoadCanonicalRulesLint: typeof _rulesLintDeps.loadCanonicalRules;
let origGetLoggerLint: typeof _rulesLintDeps.getLogger;
let origGlobHasMatchLint: typeof _rulesLintDeps.globHasMatch;
let origDiscoverWorkspacePackagesLint: typeof _rulesLintDeps.discoverWorkspacePackages;

let origGetLoggerCLI: typeof _rulesCLIDeps.getLogger;

beforeEach(() => {
  origGlobCanonicalRuleFilesLint = _rulesLintDeps.globCanonicalRuleFiles;
  origLoadCanonicalRulesLint = _rulesLintDeps.loadCanonicalRules;
  origGetLoggerLint = _rulesLintDeps.getLogger;
  origGlobHasMatchLint = _rulesLintDeps.globHasMatch;
  origDiscoverWorkspacePackagesLint = _rulesLintDeps.discoverWorkspacePackages;

  origGetLoggerCLI = _rulesCLIDeps.getLogger;
});

afterEach(() => {
  _rulesLintDeps.globCanonicalRuleFiles = origGlobCanonicalRuleFilesLint;
  _rulesLintDeps.loadCanonicalRules = origLoadCanonicalRulesLint;
  _rulesLintDeps.getLogger = origGetLoggerLint;
  _rulesLintDeps.globHasMatch = origGlobHasMatchLint;
  _rulesLintDeps.discoverWorkspacePackages = origDiscoverWorkspacePackagesLint;

  _rulesCLIDeps.getLogger = origGetLoggerCLI;
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

function captureLogger(): LogCall[] {
  const logger = makeLogger();
  _rulesLintDeps.getLogger = () => logger;
  _rulesCLIDeps.getLogger = () => logger;
  return logger.calls;
}

function captureStdout(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = originalLog;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: first root rejects, healthy root still emits warnings
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC1 first root rejects, healthy root still emits warnings", () => {
  test("[AC1] emits through the injected logger a warning attributable to a rule from the second root when the first root's loadCanonicalRules rejects", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [".nax/rules/root.md", "packages/api/.nax/rules/api.md"];
    _rulesLintDeps.loadCanonicalRules = async (root: string) => {
      if (root === "/project") {
        throw new Error("root load failed");
      }
      if (root === "/project/packages/api") {
        return [
          makeRule({
            path: "api.md",
            fileName: "api.md",
            warnings: ["second-root-only warning"],
          }),
        ];
      }
      return [];
    };
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => ["packages/api"];

    const calls = captureLogger();
    const stdout = captureStdout();

    let caught: unknown;
    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } catch (err) {
      caught = err;
    } finally {
      stdout.restore();
    }

    // The linter must reach the second root despite the first root failing,
    // so the second root's rule warnings must be observed through the logger.
    const secondRootWarn = calls.find(
      (c) =>
        c.level === "warn" &&
        c.stage === "rules-lint" &&
        (c.data?.file === "api.md" || c.data?.root === "/project/packages/api") &&
        /second-root-only warning/.test(c.message),
    );
    expect(secondRootWarn).toBeDefined();
    // AC2 covers the rejection itself; this AC is about isolation.
    expect((caught as { code?: string } | undefined)?.code).toBe("RULES_LINT_ROOT_FAILED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: rejects with NaxError RULES_LINT_ROOT_FAILED
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC2 reject with NaxError RULES_LINT_ROOT_FAILED", () => {
  test("[AC2] rejects with a NaxError whose code is RULES_LINT_ROOT_FAILED when at least one root's loadCanonicalRules rejects", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [".nax/rules/root.md", "packages/api/.nax/rules/api.md"];
    _rulesLintDeps.loadCanonicalRules = async (root: string) => {
      if (root === "/project") {
        throw new Error("root load failed");
      }
      return [];
    };
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => ["packages/api"];

    captureLogger();
    const stdout = captureStdout();

    let caught: unknown;
    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } catch (err) {
      caught = err;
    } finally {
      stdout.restore();
    }

    assertNaxError(caught, "rulesLintCommand rejection");
    expect(caught.code).toBe("RULES_LINT_ROOT_FAILED");
    expect(caught.message).toContain("/project");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: two-of-three failure context names both paths
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC3 two-of-three failure context names both paths", () => {
  test("[AC3] RULES_LINT_ROOT_FAILED rejection context names every failing root path when two of three roots reject", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [
      ".nax/rules/root.md",
      "packages/api/.nax/rules/api.md",
      "packages/web/.nax/rules/web.md",
    ];
    _rulesLintDeps.loadCanonicalRules = async (root: string) => {
      if (root === "/project" || root === "/project/packages/api") {
        throw new Error(`load failed: ${root}`);
      }
      return [];
    };
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => ["packages/api", "packages/web"];

    captureLogger();
    const stdout = captureStdout();

    let caught: unknown;
    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } catch (err) {
      caught = err;
    } finally {
      stdout.restore();
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("RULES_LINT_ROOT_FAILED");
    const ctx = (caught as { context?: Record<string, unknown> }).context ?? {};
    const failedRoots = ctx.failedRoots;
    expect(Array.isArray(failedRoots)).toBe(true);
    expect(failedRoots as string[]).toContain("/project");
    expect(failedRoots as string[]).toContain("/project/packages/api");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: every root loads with warnings, resolves without rejecting
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC4 all roots load with warnings, resolves", () => {
  test("[AC4] resolves without rejecting when every root loads successfully and only warnings are produced", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [".nax/rules/root.md", "packages/api/.nax/rules/api.md"];
    _rulesLintDeps.loadCanonicalRules = async () => [
      makeRule({
        path: "with-warns.md",
        fileName: "with-warns.md",
        warnings: ["stub warning"],
      }),
    ];
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => ["packages/api"];

    captureLogger();
    const stdout = captureStdout();

    let caught: unknown;
    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } catch (err) {
      caught = err;
    } finally {
      stdout.restore();
    }

    expect(caught).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: every root loads with warnings, emits [WARN] summary line
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC5 all roots load with warnings, [WARN] summary", () => {
  test("[AC5] emits the [WARN] summary line when every root loads successfully and warnings are produced", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [".nax/rules/root.md", "packages/api/.nax/rules/api.md"];
    _rulesLintDeps.loadCanonicalRules = async () => [
      makeRule({
        path: "with-warns.md",
        fileName: "with-warns.md",
        warnings: ["stub warning"],
      }),
    ];
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => ["packages/api"];

    captureLogger();
    const stdout = captureStdout();

    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } finally {
      stdout.restore();
    }

    const summary = stdout.lines.find((l) => /\[WARN\] Canonical rules lint completed with \d+ warning\(s\)/.test(l));
    expect(summary).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: empty canonical store emits logger warning
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC6 empty canonical store emits logger warning", () => {
  test("[AC6] emits an empty-store warning through the injected logger when no root yields any rule file", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [];
    _rulesLintDeps.loadCanonicalRules = async () => [];
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => [];

    const calls = captureLogger();

    await rulesLintCommandFromLint({ dir: "/project" });

    const emptyStoreWarn = calls.find(
      (c) =>
        c.level === "warn" &&
        c.stage === "rules-lint" &&
        /empty store|no.*rule|canonical.*rules.*store/i.test(c.message),
    );
    expect(emptyStoreWarn).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: empty canonical store resolves without rejecting
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC7 empty canonical store resolves", () => {
  test("[AC7] resolves without rejecting when no root yields any rule file", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [];
    _rulesLintDeps.loadCanonicalRules = async () => [];
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => [];

    captureLogger();
    const stdout = captureStdout();

    let caught: unknown;
    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } catch (err) {
      caught = err;
    } finally {
      stdout.restore();
    }

    expect(caught).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: empty canonical store emits [WARN] summary line
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC8 empty canonical store emits [WARN] summary", () => {
  test("[AC8] emits the [WARN] summary line when no rule root yields any rule file", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [];
    _rulesLintDeps.loadCanonicalRules = async () => [];
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => [];

    captureLogger();
    const stdout = captureStdout();

    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } finally {
      stdout.restore();
    }

    const summary = stdout.lines.find((l) => /\[WARN\] Canonical rules lint completed with \d+ warning\(s\)/.test(l));
    expect(summary).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: empty canonical store does NOT emit [OK] summary line
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC9 empty canonical store does NOT emit [OK] summary", () => {
  test("[AC9] does not emit the [OK] summary line when no root yields any rule file", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [];
    _rulesLintDeps.loadCanonicalRules = async () => [];
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => [];

    captureLogger();
    const stdout = captureStdout();

    try {
      await rulesLintCommandFromLint({ dir: "/project" });
    } finally {
      stdout.restore();
    }

    const ok = stdout.lines.find((l) => /\[OK\] Canonical rules lint passed/.test(l));
    expect(ok).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: at least one rule file + no other warning condition -> no empty-store warning
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC10 at least one rule file: no empty-store warning", () => {
  test("[AC10] emits no empty-store warning when at least one root yields at least one rule file and no other warning condition holds", async () => {
    _rulesLintDeps.globCanonicalRuleFiles = () => [".nax/rules/root.md"];
    _rulesLintDeps.loadCanonicalRules = async () => [
      makeRule({
        path: "ok.md",
        fileName: "ok.md",
        warnings: [],
      }),
    ];
    _rulesLintDeps.globHasMatch = () => "match";
    _rulesLintDeps.discoverWorkspacePackages = async () => [];

    const calls = captureLogger();

    await rulesLintCommandFromLint({ dir: "/project" });

    const emptyStoreWarn = calls.find(
      (c) =>
        c.level === "warn" &&
        c.stage === "rules-lint" &&
        /empty store|no.*rule|canonical.*rules.*store/i.test(c.message),
    );
    expect(emptyStoreWarn).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rules export (claude) — scope and description (rulesExportCommand family)
//
// Absorbed from rules-export-description.test.ts (US-002 description in
// Claude frontmatter) and rules-export-scope.test.ts (package scope becomes a
// file glob). Both share the same injection harness, so one describe-scoped
// hook pair serves both; the top-level hooks above stay scoped to the
// US-002 lint suites they were written for.
// ─────────────────────────────────────────────────────────────────────────────

describe("rules export (claude) — scope becomes a file glob, description in frontmatter", () => {
  let origExportWriteFile: typeof _rulesCLIDeps.writeFile;
  let origExportGlobInDir: typeof _rulesCLIDeps.globInDir;
  let origExportMkdir: typeof _rulesCLIDeps.mkdir;
  let origExportLoadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;
  let origExportGetLogger: typeof _rulesCLIDeps.getLogger;

  const exportWritten: Record<string, string> = {};
  let exportWarnings: Array<{ msg: string; data: unknown }> = [];

  beforeEach(() => {
    origExportWriteFile = _rulesCLIDeps.writeFile;
    origExportGlobInDir = _rulesCLIDeps.globInDir;
    origExportMkdir = _rulesCLIDeps.mkdir;
    origExportLoadCanonicalRules = _rulesCLIDeps.loadCanonicalRules;
    origExportGetLogger = _rulesCLIDeps.getLogger;

    for (const k of Object.keys(exportWritten)) delete exportWritten[k];
    exportWarnings = [];

    _rulesCLIDeps.writeFile = async (path, content) => {
      exportWritten[path] = content;
    };
    _rulesCLIDeps.globInDir = () => [];
    _rulesCLIDeps.mkdir = async () => {};
    _rulesCLIDeps.loadCanonicalRules = async () => [];
    _rulesCLIDeps.getLogger = () => {
      const logger = makeLogger();
      logger.warn = mock((_s: string, msg: string, data: unknown) =>
        exportWarnings.push({ msg, data }),
      ) as typeof logger.warn;
      return logger;
    };
  });

  afterEach(() => {
    _rulesCLIDeps.writeFile = origExportWriteFile;
    _rulesCLIDeps.globInDir = origExportGlobInDir;
    _rulesCLIDeps.mkdir = origExportMkdir;
    _rulesCLIDeps.loadCanonicalRules = origExportLoadCanonicalRules;
    _rulesCLIDeps.getLogger = origExportGetLogger;
  });

  /** Export one rule and return the generated file body. */
  async function exportOne(rule: Partial<CanonicalRule>): Promise<string> {
    _rulesCLIDeps.loadCanonicalRules = async () => [{ fileName: "r.md", content: "Body.", ...rule }];
    await rulesExportCommand({ dir: "/project", agent: "claude" });
    return exportWritten["/project/.claude/rules/r.md"] ?? "";
  }

  /** Strip the leading frontmatter block; returns the body the agent will read. */
  function bodyAfterFrontmatter(out: string): string {
    // claudeFrontmatter emits `---\n...\n---\n` and then the body. If there is
    // no frontmatter, the input is returned unchanged.
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(out);
    return m ? out.slice(m[0].length) : out;
  }

  /** Return the YAML block delimited by the FIRST pair of `---` markers. */
  function frontmatterBlock(out: string): string {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(out);
    return m?.[1] ?? "";
  }

  test("[AC1] description appears before paths in the generated frontmatter", async () => {
    const out = await exportOne({ description: "Use when editing OAuth controllers", appliesTo: ["src/**/*.ts"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    const descIdx = fm.indexOf("description:");
    const pathsIdx = fm.indexOf("paths:");
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(pathsIdx).toBeGreaterThanOrEqual(0);
    expect(descIdx).toBeLessThan(pathsIdx);
  });

  test("[AC2] description with no scope still emits a frontmatter block, with no paths entry", async () => {
    const out = await exportOne({ description: "Standalone rule" });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).toContain("description:");
    expect(fm).not.toContain("paths:");
    // The body still follows the frontmatter.
    expect(bodyAfterFrontmatter(out)).toContain("Body.");
  });

  test("[AC3] canonical package scope becomes the corresponding file glob next to description", async () => {
    const out = await exportOne({ description: "API-only rule", paths: ["packages/api/*"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).toContain("description:");
    expect(fm).toContain('  - "packages/api/**"');
    expect(fm).not.toContain('packages/api/*"');

    // No "dropping package scope" warning — translating is not dropping.
    expect(exportWarnings.find((w) => w.msg.includes("package scope"))).toBeUndefined();
  });

  test("[AC4] neither description nor scope => no frontmatter block at all", async () => {
    const out = await exportOne({});

    expect(out.startsWith("---")).toBe(false);
    // Body still present.
    expect(out).toContain("Body.");
  });

  test("[AC5] description with colon, hash, double quote, and backslash parses as YAML and round-trips exactly", async () => {
    const tricky = 'status: ok # note "quote"\\';
    const out = await exportOne({ description: tricky, appliesTo: ["src/**/*.ts"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).toContain(`description: ${JSON.stringify(tricky)}`);

    // The block — the same substring the YAML parser would see — must parse
    // cleanly and yield back the original, unescaped text.
    const parsed = Bun.YAML.parse(fm) as { description?: unknown; paths?: unknown };
    expect(typeof parsed.description).toBe("string");
    expect(parsed.description).toBe(tricky);
    // paths still present alongside description.
    expect(parsed.paths).toEqual(["src/**/*.ts"]);
  });

  test("[AC6] the both-scopes warning carries the rule's description through to its structured data", async () => {
    const description = "Auth-facing controller rules";
    const out = await exportOne({
      description,
      appliesTo: ["src/**/*.ts"],
      paths: ["packages/api/*"],
    });

    // The file keeps appliesTo and drops paths (Claude cannot express both).
    expect(out).toContain('  - "src/**/*.ts"');
    expect(out).not.toContain("packages/api");

    const w = exportWarnings.find((x) => x.msg.includes("package scope"));
    expect(w).toBeDefined();
    const payload = JSON.stringify(w?.data);
    expect(payload).toContain(`"description":${JSON.stringify(description)}`);
  });

  test("[AC7] a rule with appliesTo but no description emits no description entry", async () => {
    const out = await exportOne({ appliesTo: ["src/**/*.ts"] });

    expect(out.startsWith("---\n")).toBe(true);
    const fm = frontmatterBlock(out);
    expect(fm).not.toContain("description:");
    expect(fm).toContain("paths:");
    expect(fm).toContain('  - "src/**/*.ts"');
  });

  describe("rules export (claude) — the scopes that cannot be combined", () => {
    test.each([
      // [canonical paths:, expected Claude paths:]
      ["packages/nestjs-oauth/*", "packages/nestjs-oauth/**"],
      ["packages/api/**", "packages/api/**"],
      ["apps/web", "apps/web/**"],
      ["packages/*/core", "packages/*/core/**"],
      // A trailing slash names the same directory and must not change the result.
      ["packages/api/", "packages/api/**"],
      ["packages/api/*/", "packages/api/**"],
    ])("canonical paths %p exports as Claude glob %p", async (canonical, expected) => {
      const out = await exportOne({ paths: [canonical] });
      expect(out.startsWith("---\n")).toBe(true);
      expect(out).toContain(`  - ${JSON.stringify(expected)}`);
    });

    test("a package-scoped rule is no longer emitted without frontmatter", async () => {
      const out = await exportOne({ paths: ["packages/nestjs-oauth/*"] });
      expect(out.startsWith("---\n")).toBe(true);
      expect(out).toContain("paths:");
    });

    test("translating is not a drop, so nothing warns about lost package scope", async () => {
      await exportOne({ paths: ["packages/nestjs-oauth/*"] });
      expect(exportWarnings.find((w) => w.msg.includes("package scope"))).toBeUndefined();
    });

    test("every canonical path is carried, not just the first", async () => {
      const out = await exportOne({ paths: ["packages/a/*", "packages/b/*"] });
      expect(out).toContain('  - "packages/a/**"');
      expect(out).toContain('  - "packages/b/**"');
    });

    test("nax's own paths: spelling never reaches the generated file", async () => {
      const out = await exportOne({ paths: ["packages/api/*"] });
      expect(out).not.toContain("appliesTo:");
      // Claude reads `paths:`; the canonical key name means nothing to it.
      expect(out.split("---")[1]).toContain("paths:");
    });

    test("keeps the file glob and warns when both scopes are set", async () => {
      const out = await exportOne({ appliesTo: ["src/**/*.ts"], paths: ["packages/api/*"] });
      expect(out).toContain('  - "src/**/*.ts"');
      expect(out).not.toContain("packages/api");

      const w = exportWarnings.find((x) => x.msg.includes("package scope"));
      expect(w).toBeDefined();
      expect(JSON.stringify(w?.data)).toContain("packages/api/*");
    });

    test("an unscoped rule still gets no frontmatter block", async () => {
      const out = await exportOne({});
      expect(out.startsWith("---")).toBe(false);
      expect(out).toContain("Body.");
    });
  });
});
