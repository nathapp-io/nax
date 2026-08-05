/**
 * rules-lint.ts — inert paths: scoping warnings (US-002)
 *
 * Tests the inert-`paths:` and displaced-frontmatter warnings emitted by
 * `rulesLintCommand`. These tests stub the workspace resolver and the
 * canonical loader via the injectable deps so they do not need a fixture
 * monorepo.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _rulesCLIDeps, _rulesLintDeps, rulesLintCommand, rulesLintCommandDirect } from "@/cli";
import { loadCanonicalRules as loadCanonicalRulesImpl } from "@/context/engine";
import type { CanonicalRule } from "@/context/engine";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let tempDirForDisplacement: string | undefined;

let origLintDeps: {
  globCanonicalRuleFiles: typeof _rulesLintDeps.globCanonicalRuleFiles;
  loadCanonicalRules: typeof _rulesLintDeps.loadCanonicalRules;
  globHasMatch: typeof _rulesLintDeps.globHasMatch;
  getLogger: typeof _rulesLintDeps.getLogger;
  discoverWorkspacePackages?: (workdir: string) => Promise<string[]>;
};

let origCliDeps: {
  globCanonicalRuleFiles: typeof _rulesCLIDeps.globCanonicalRuleFiles;
  loadCanonicalRules: typeof _rulesCLIDeps.loadCanonicalRules;
  globHasMatch: typeof _rulesCLIDeps.globHasMatch;
  getLogger: typeof _rulesCLIDeps.getLogger;
  discoverWorkspacePackages?: (workdir: string) => Promise<string[]>;
};

beforeEach(() => {
  tempDirForDisplacement = makeTempDir("nax-rules-lint-displacement-");
  origLintDeps = {
    globCanonicalRuleFiles: _rulesLintDeps.globCanonicalRuleFiles,
    loadCanonicalRules: _rulesLintDeps.loadCanonicalRules,
    globHasMatch: _rulesLintDeps.globHasMatch,
    getLogger: _rulesLintDeps.getLogger,
    ...((_rulesLintDeps as Record<string, unknown>).discoverWorkspacePackages
      ? {
          discoverWorkspacePackages: (_rulesLintDeps as Record<string, unknown>).discoverWorkspacePackages as (
            workdir: string,
          ) => Promise<string[]>,
        }
      : {}),
  };
  origCliDeps = {
    globCanonicalRuleFiles: _rulesCLIDeps.globCanonicalRuleFiles,
    loadCanonicalRules: _rulesCLIDeps.loadCanonicalRules,
    globHasMatch: _rulesCLIDeps.globHasMatch,
    getLogger: _rulesCLIDeps.getLogger,
    ...((_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages
      ? {
          discoverWorkspacePackages: (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages as (
            workdir: string,
          ) => Promise<string[]>,
        }
      : {}),
  };
});

afterEach(() => {
  _rulesLintDeps.globCanonicalRuleFiles = origLintDeps.globCanonicalRuleFiles;
  _rulesLintDeps.loadCanonicalRules = origLintDeps.loadCanonicalRules;
  _rulesLintDeps.globHasMatch = origLintDeps.globHasMatch;
  _rulesLintDeps.getLogger = origLintDeps.getLogger;
  if (origLintDeps.discoverWorkspacePackages) {
    (_rulesLintDeps as Record<string, unknown>).discoverWorkspacePackages = origLintDeps.discoverWorkspacePackages;
  }

  _rulesCLIDeps.globCanonicalRuleFiles = origCliDeps.globCanonicalRuleFiles;
  _rulesCLIDeps.loadCanonicalRules = origCliDeps.loadCanonicalRules;
  _rulesCLIDeps.globHasMatch = origCliDeps.globHasMatch;
  _rulesCLIDeps.getLogger = origCliDeps.getLogger;
  if (origCliDeps.discoverWorkspacePackages) {
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = origCliDeps.discoverWorkspacePackages;
  }

  cleanupTempDir(tempDirForDisplacement);
  tempDirForDisplacement = undefined;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<CanonicalRule>): CanonicalRule {
  return {
    fileName: "rule.md",
    path: "rule.md",
    content: "Body.",
    warnings: [],
    ...overrides,
  };
}

interface Call {
  level: string;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

function captureLogger(): { calls: Call[] } {
  const calls: Call[] = [];
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
  return { calls };
}

function stubLintDeps(rules: CanonicalRule[]): void {
  _rulesCLIDeps.globCanonicalRuleFiles = () => [];
  _rulesCLIDeps.loadCanonicalRules = async () => rules;
  _rulesCLIDeps.globHasMatch = () => true;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: displaced-frontmatter warning carries the HTML comment text
// ─────────────────────────────────────────────────────────────────────────────

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
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => [];
    const { calls } = captureLogger();

    await rulesLintCommand({ dir: tempDirForDisplacement as string });

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

// ─────────────────────────────────────────────────────────────────────────────
// AC2/AC5/AC6: inert-`paths:` warnings — file field, appliesTo alternative,
// no warning when no paths declared
// ─────────────────────────────────────────────────────────────────────────────

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
    stubLintDeps([makeRule({ path: rulePath, fileName: rulePath, paths: ["src/**/*.ts"] })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => [];
    const { calls } = captureLogger();

    await rulesLintCommand({ dir: tempDir });

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
    stubLintDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => [];
    const { calls } = captureLogger();

    await rulesLintCommand({ dir: tempDir });

    const inert = calls.find((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBeDefined();
    expect(inert?.message.toLowerCase()).toContain("appliesto");
  });

  test("[AC4] emits no inert-paths warning when discoverWorkspacePackages resolves to a non-empty package list", async () => {
    stubLintDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => ["packages/api", "packages/web"];
    const { calls } = captureLogger();

    await rulesLintCommand({ dir: tempDir });

    const inert = calls.some((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBe(false);
  });

  test("[AC5] emits no inert-paths warning for a rule declaring no paths key when discoverWorkspacePackages resolves empty", async () => {
    stubLintDeps([makeRule({ path: "unscoped.md", fileName: "unscoped.md" })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => [];
    const { calls } = captureLogger();

    await rulesLintCommand({ dir: tempDir });

    const inert = calls.some((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: exit code stays 0 when only warnings are emitted
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC6 exit code stays 0 on warnings only", () => {
  test("[AC6] resolves without setting a non-zero process.exitCode when the only signal is warnings", async () => {
    stubLintDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => [];
    captureLogger();

    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await rulesLintCommand({ dir: "/project" });
      expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: warning count is reflected in the summary line and a logger field
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC7 summary line counts warnings", () => {
  test("[AC7] the final stdout [WARN] summary line includes an inert-paths warning in N", async () => {
    stubLintDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => [];
    const { calls } = captureLogger();

    const originalLog = console.log;
    const stdoutLines: string[] = [];
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await rulesLintCommand({ dir: "/project" });
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

// ─────────────────────────────────────────────────────────────────────────────
// AC8/AC9: fail-open when discoverWorkspacePackages rejects
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 rulesLintCommand — AC8/AC9 fail-open on rejection", () => {
  test("[AC8] emits no inert-paths warning when discoverWorkspacePackages rejects", async () => {
    stubLintDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => {
      throw new Error("detection failed");
    };
    const { calls } = captureLogger();

    await rulesLintCommand({ dir: "/project" });

    const inert = calls.some((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBe(false);
  });

  test("[AC9] still emits its final stdout summary line when discoverWorkspacePackages rejects", async () => {
    stubLintDeps([makeRule({ path: "scoped.md", fileName: "scoped.md", paths: ["src/**/*.ts"] })]);
    (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages = async () => {
      throw new Error("detection failed");
    };
    captureLogger();

    const originalLog = console.log;
    const stdoutLines: string[] = [];
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await rulesLintCommand({ dir: "/project" });
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

// ─────────────────────────────────────────────────────────────────────────────
// Dep registration: _rulesLintDeps and _rulesCLIDeps carry discoverWorkspacePackages
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 deps registration — discoverWorkspacePackages", () => {
  test("_rulesLintDeps exposes discoverWorkspacePackages", () => {
    expect(typeof (_rulesLintDeps as Record<string, unknown>).discoverWorkspacePackages).toBe("function");
  });

  test("_rulesCLIDeps exposes discoverWorkspacePackages", () => {
    expect(typeof (_rulesCLIDeps as Record<string, unknown>).discoverWorkspacePackages).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: rulesLintCommandDirect also receives the dependency via its dep arg
// ─────────────────────────────────────────────────────────────────────────────

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

    const calls: Call[] = [];
    const logger = {
      warn: (stage: string, message: string, data?: Record<string, unknown>) => {
        calls.push({ level: "warn", stage, message, data });
      },
      info: () => {},
      debug: () => {},
      error: () => {},
    };

    await rulesLintCommandDirect(
      { dir: "/project" },
      {
        globCanonicalRuleFiles: _rulesCLIDeps.globCanonicalRuleFiles,
        loadCanonicalRules: _rulesCLIDeps.loadCanonicalRules,
        globHasMatch: _rulesCLIDeps.globHasMatch,
        getLogger: () => logger as unknown as ReturnType<typeof _rulesLintDeps.getLogger>,
        discoverWorkspacePackages: async () => [],
      },
    );

    const inert = calls.some((c) => c.level === "warn" && c.stage === "rules-lint" && c.data?.code === "INERT_PATHS");
    expect(inert).toBe(true);
  });
});
