/**
 * PR 3 (follow-up 8, findings H8/L5) — reconcile literal scope matching between
 * attribution and selection.
 *
 * #2099 anchored literal scopePaths exactly to stop #2091's cross-package
 * over-attribution, but a per-package rule's `appliesTo:` literal is
 * package-relative while the scope-file set and the git diff are repo-rooted
 * (nax#2071). The two matchers also disagreed about the same string:
 * `ruleMatchesScopeFiles` (selection) suffix-globbed every pattern while
 * `pathMatchesScope` (attribution) required an exact match for a literal — so a
 * rule could be admitted for a story and then penalised as "ignored" for being
 * followed.
 *
 * These tests pin the reconciliation:
 *   - a package-relative literal is framed into the repo frame (using the
 *     rule's owning package) before either comparison, and
 *   - both matchers share one literal-vs-glob decision, so they agree.
 *
 * The #2091 control — a same-named file in a *different* package must not be
 * attributed — is asserted here as well as in effectiveness.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildEvidenceTerms, classifyWithTerms, pathMatchesScope } from "@/context/engine/effectiveness";
import { _staticRulesDeps, ruleMatchesScopeFiles, StaticRulesProvider } from "@/context/engine/providers/static-rules";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Dep save/restore
// ─────────────────────────────────────────────────────────────────────────────

let origDeps: {
  loadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
  fileExists: typeof _staticRulesDeps.fileExists;
  readFile: typeof _staticRulesDeps.readFile;
  globInDir: typeof _staticRulesDeps.globInDir;
};

beforeEach(() => {
  origDeps = {
    loadCanonicalRules: _staticRulesDeps.loadCanonicalRules,
    fileExists: _staticRulesDeps.fileExists,
    readFile: _staticRulesDeps.readFile,
    globInDir: _staticRulesDeps.globInDir,
  };
  _staticRulesDeps.loadCanonicalRules = async () => [];
  _staticRulesDeps.fileExists = async () => false;
  _staticRulesDeps.readFile = async () => "";
  _staticRulesDeps.globInDir = () => [];
});

afterEach(() => {
  _staticRulesDeps.loadCanonicalRules = origDeps.loadCanonicalRules;
  _staticRulesDeps.fileExists = origDeps.fileExists;
  _staticRulesDeps.readFile = origDeps.readFile;
  _staticRulesDeps.globInDir = origDeps.globInDir;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MONOREPO_REQUEST: ContextRequest = {
  storyId: "US-003",
  repoRoot: "/repo",
  packageDir: "/repo/packages/api",
  storyWorkdir: "packages/api",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

const PACKAGE_RULE: CanonicalRule = {
  id: "retry-strategy",
  fileName: "retry-strategy.md",
  path: "retry-strategy.md",
  content: "## Retry\n\nRetry body.",
  appliesTo: ["src/session/session-keeper.ts"],
};

const CHUNK_SUMMARY = "JWT authentication tokens stored in secure cookies for session management";

function diffFor(filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,1 +1,1 @@",
    "-old line",
    `+${CHUNK_SUMMARY}`,
  ].join("\n");
}

/** The package rule loads only for the story's package directory. */
function setupPackageRule(rule: CanonicalRule): void {
  _staticRulesDeps.loadCanonicalRules = async (workdir: string) =>
    workdir === MONOREPO_REQUEST.packageDir ? [rule] : [];
}

/**
 * Mirror of setupPackageRule: the rule loads only at the REPO root, and the
 * package directory has NO rules of its own — the shape the #2113 hoist
 * regression test needs, since the pre-hoist framing block lived inside the
 * `packageRules.length > 0` guard and never ran for a package with zero
 * package-level rules of its own.
 */
function setupRepoRule(rule: CanonicalRule): void {
  _staticRulesDeps.loadCanonicalRules = async (workdir: string) =>
    workdir === MONOREPO_REQUEST.repoRoot ? [rule] : [];
}

const REPO_RULE: CanonicalRule = {
  id: "session-keeper-rule",
  fileName: "session-keeper-rule.md",
  path: "session-keeper-rule.md",
  content: "## Session Keeper\n\nSession keeper body.",
  appliesTo: ["src/session/session-keeper.ts"],
};

// ─────────────────────────────────────────────────────────────────────────────
// H8 — the provider frames a package-relative literal `appliesTo` into the
// repo frame before emitting scopePaths.
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — package-relative literal appliesTo is framed (H8)", () => {
  test("emits the chunk with a repo-framed scopePaths for a package-relative literal", async () => {
    setupPackageRule(PACKAGE_RULE);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({
      ...MONOREPO_REQUEST,
      scopeFiles: ["packages/api/src/session/session-keeper.ts"],
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/api/src/session/session-keeper.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H8 / path-frame C1 — under worktree isolation the frame MUST come from
// request.storyWorkdir, not a `relative(repoRoot, packageDir)` derivation.
// `repoRoot` is the main checkout while `packageDir` is the worktree package
// path, so that derivation yields ".nax-wt/US-001/packages/api": the rule's
// package-relative literal is framed wrong, no scope file matches it, and the
// rule is silently dropped.
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — worktree isolation frames from storyWorkdir (H8/C1)", () => {
  const WORKTREE_REQUEST: ContextRequest = {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo/.nax-wt/US-001/packages/api",
    storyWorkdir: "packages/api",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
  };

  test("selects the package rule and frames its literal from storyWorkdir", async () => {
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) =>
      workdir === WORKTREE_REQUEST.packageDir ? [PACKAGE_RULE] : [];

    const provider = new StaticRulesProvider();
    const result = await provider.fetch({
      ...WORKTREE_REQUEST,
      scopeFiles: ["packages/api/src/session/session-keeper.ts"],
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/api/src/session/session-keeper.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H8 — the attribution regression: the produced chunk is attributed, not
// ignored, against its repo-framed diff.
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyWithTerms — a package-relative literal is attributed after framing (H8)", () => {
  test("a chunk produced for the package is attributed, not ignored, against its repo-framed diff", async () => {
    setupPackageRule(PACKAGE_RULE);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({
      ...MONOREPO_REQUEST,
      scopeFiles: ["packages/api/src/session/session-keeper.ts"],
    });
    const scopePaths = result.chunks[0]?.scopePaths ?? [];

    const diffText = diffFor("packages/api/src/session/session-keeper.ts");
    const evidence = buildEvidenceTerms("", diffText, []);
    const effectiveness = classifyWithTerms(CHUNK_SUMMARY, evidence, { scopePaths, diffText });

    expect(effectiveness.signal).toBe("followed");
  });

  test("the rule does not attribute a same-named file in ANOTHER package (#2091 control)", async () => {
    // The rule belongs to packages/api; the changed file is packages/web. Framing
    // must not turn the literal into a cross-package suffix match.
    setupPackageRule(PACKAGE_RULE);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({
      ...MONOREPO_REQUEST,
      scopeFiles: ["packages/web/src/session/session-keeper.ts"],
    });
    expect(result.chunks).toHaveLength(0);

    // And an unframed literal reaching attribution must still not match the
    // other package's file — exact anchoring keeps #2091 fixed.
    const diffText = diffFor("packages/web/src/session/session-keeper.ts");
    const evidence = buildEvidenceTerms("", diffText, []);
    const effectiveness = classifyWithTerms(CHUNK_SUMMARY, evidence, {
      scopePaths: ["src/session/session-keeper.ts"],
      diffText,
    });
    expect(effectiveness.signal).toBe("ignored");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nax#2113 — repo-level rules must be framed too, not only package rules.
//
// `frameAppliesTo` used to apply only to `packageRules`, so a REPO-LEVEL rule
// whose `appliesTo` is a package-relative literal (e.g.
// "src/session/session-keeper.ts") stopped selecting entirely in a monorepo —
// the literal never matched the repo-framed scopeFiles/diff. The ruling: this
// is a bug, and framing a repo-level literal is strictly tighter than the
// pre-#2091 behaviour (a framed literal is compared with === against exactly
// one repo-rooted string, so it cannot reach a sibling package).
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — repo-level rules are framed too (nax#2113)", () => {
  test("a repo-level rule with a package-relative literal appliesTo selects for the in-scope package", async () => {
    setupRepoRule(REPO_RULE);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({
      ...MONOREPO_REQUEST,
      scopeFiles: ["packages/api/src/session/session-keeper.ts"],
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Session keeper body.");
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/api/src/session/session-keeper.ts"]);
  });

  test("#2091 control: a repo-level rule's framed literal does not select/attribute a same-named file in a different package", async () => {
    setupRepoRule(REPO_RULE);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({
      ...MONOREPO_REQUEST,
      scopeFiles: ["packages/web/src/session/session-keeper.ts"],
    });

    expect(result.chunks).toHaveLength(0);
  });

  test("the hoist: a monorepo package with ZERO package-level rules still gets its repo-level literal framed and selected", async () => {
    // Regression test for the trap: the framing block used to live inside
    // `if (packageRules.length > 0)`, so a package with no rules of its own —
    // the common monorepo shape — never entered it and the repo-level literal
    // stayed unframed and silently dropped, even though `mergedRules` still
    // equalled `repoRules` (this exact scenario). This is the test that must
    // FAIL before the hoist and PASS after it.
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) =>
      workdir === MONOREPO_REQUEST.repoRoot ? [REPO_RULE] : [];
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({
      ...MONOREPO_REQUEST,
      scopeFiles: ["packages/api/src/session/session-keeper.ts"],
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual(["packages/api/src/session/session-keeper.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invariant — selection and attribution agree on the same string.
// ─────────────────────────────────────────────────────────────────────────────

describe("ruleMatchesScopeFiles and pathMatchesScope agree on the same string", () => {
  const CASES: Array<{ label: string; pattern: string; file: string; expected: boolean }> = [
    {
      label: "cross-package literal (#2091)",
      pattern: "src/client.ts",
      file: "packages/web/src/client.ts",
      expected: false,
    },
    {
      label: "unframed package-relative literal is not a suffix match",
      pattern: "src/session/session-keeper.ts",
      file: "packages/api/src/session/session-keeper.ts",
      expected: false,
    },
    {
      label: "repo-framed literal",
      pattern: "packages/api/src/session/session-keeper.ts",
      file: "packages/api/src/session/session-keeper.ts",
      expected: true,
    },
    {
      label: "single-package literal",
      pattern: "src/foo.ts",
      file: "src/foo.ts",
      expected: true,
    },
    {
      label: "authored package-relative glob",
      pattern: "src/agents/**/*.ts",
      file: "packages/api/src/agents/adapter.ts",
      expected: true,
    },
    {
      label: "repo-framed glob",
      pattern: "packages/api/**",
      file: "packages/api/src/x.ts",
      expected: true,
    },
  ];

  for (const testCase of CASES) {
    test(`agree: ${testCase.label}`, () => {
      const selection = ruleMatchesScopeFiles([testCase.pattern], [testCase.file]);
      const attribution = pathMatchesScope([testCase.pattern], testCase.file);

      expect(selection).toBe(testCase.expected);
      expect(attribution).toBe(testCase.expected);
      expect(selection).toBe(attribution);
    });
  }
});
