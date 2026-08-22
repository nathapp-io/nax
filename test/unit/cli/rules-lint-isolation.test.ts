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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _rulesCLIDeps, _rulesLintDeps, rulesLintCommandDirect as rulesLintCommandFromLint } from "@/cli";
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

interface IsolationCall {
  level: string;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

function makeRule(overrides: Partial<CanonicalRule>): CanonicalRule {
  return {
    fileName: "rule.md",
    path: "rule.md",
    content: "Body.",
    warnings: [],
    ...overrides,
  };
}

function captureLogger(): IsolationCall[] {
  const calls: IsolationCall[] = [];
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
  _rulesLintDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>;
  _rulesCLIDeps.getLogger = () => logger as unknown as ReturnType<typeof _rulesCLIDeps.getLogger>;
  return calls;
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("RULES_LINT_ROOT_FAILED");
    expect((caught as Error).message).toContain("/project");
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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
    _rulesLintDeps.globHasMatch = () => true;
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
