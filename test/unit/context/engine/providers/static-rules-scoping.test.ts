/**
 * StaticRulesProvider — rule scoping tests (US: rule-scoping).
 *
 * Covers two NEW filter passes applied after the existing paths:/appliesTo:
 * filters: stage filtering (request.stage vs rule.stages) and appliesTo
 * filtering keyed on request.scopeFiles (not touchedFiles), plus the
 * ProviderScopingReport persisted alongside budgetPressure.
 *
 * Split from static-rules.test.ts / static-rules-paths.test.ts per
 * test-architecture.md — static-rules.test.ts is at 783/800 lines.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { StaticRulesProvider, _staticRulesDeps, ContextOrchestrator } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection helpers
// ─────────────────────────────────────────────────────────────────────────────

let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
let origFileExists: typeof _staticRulesDeps.fileExists;
let origReadFile: typeof _staticRulesDeps.readFile;
let origGlobInDir: typeof _staticRulesDeps.globInDir;

beforeEach(() => {
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  origFileExists = _staticRulesDeps.fileExists;
  origReadFile = _staticRulesDeps.readFile;
  origGlobInDir = _staticRulesDeps.globInDir;
  _staticRulesDeps.loadCanonicalRules = async () => [];
  _staticRulesDeps.fileExists = async () => false;
  _staticRulesDeps.readFile = async () => "";
  _staticRulesDeps.globInDir = () => [];
});

afterEach(() => {
  _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  _staticRulesDeps.fileExists = origFileExists;
  _staticRulesDeps.readFile = origReadFile;
  _staticRulesDeps.globInDir = origGlobInDir;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-004",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1-3: stages: frontmatter filter
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — stages: frontmatter filter", () => {
  test("AC1: returns no chunk for a rule with stages ['plan'] when request.stage is execution", async () => {
    setupCanonical([{ fileName: "stage-only.md", content: "Plan-only rule.", stages: ["plan"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    expect(result.chunks).toHaveLength(0);
  });

  test("AC2: returns a chunk for a rule with stages ['plan'] when request.stage is plan", async () => {
    setupCanonical([{ fileName: "stage-only.md", content: "Plan-only rule.", stages: ["plan"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "plan" });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Plan-only rule.");
  });

  test("AC3: returns a chunk for a rule with no stages key for every request stage", async () => {
    setupCanonical([{ fileName: "global-stage.md", content: "Applies everywhere." }]);
    const provider = new StaticRulesProvider();

    const planResult = await provider.fetch({ ...BASE_REQUEST, stage: "plan" });
    expect(planResult.chunks).toHaveLength(1);

    const executionResult = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    expect(executionResult.chunks).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4-6: appliesTo: filter keyed on scopeFiles
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — appliesTo: filter keyed on scopeFiles", () => {
  test("AC4: returns no chunk for appliesTo ['test/**/*.test.ts'] when scopeFiles contains only src/foo.ts", async () => {
    setupCanonical([{ fileName: "test-rule.md", content: "Test-only rule.", appliesTo: ["test/**/*.test.ts"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["src/foo.ts"] });
    expect(result.chunks).toHaveLength(0);
  });

  test("AC5: returns a chunk for appliesTo ['test/**/*.test.ts'] when scopeFiles contains test/unit/foo.test.ts and touchedFiles is empty", async () => {
    setupCanonical([{ fileName: "test-rule.md", content: "Test-only rule.", appliesTo: ["test/**/*.test.ts"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({
      ...BASE_REQUEST,
      scopeFiles: ["test/unit/foo.test.ts"],
      touchedFiles: [],
    });
    expect(result.chunks).toHaveLength(1);
  });

  test("AC6: returns a chunk for a rule declaring appliesTo when scopeFiles is empty", async () => {
    setupCanonical([{ fileName: "test-rule.md", content: "Test-only rule.", appliesTo: ["test/**/*.test.ts"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: [] });
    expect(result.chunks).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7-11: scopingReport
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — scopingReport", () => {
  test("AC7: returns scopingReport.appliesToInertCount 1 when one rule declares appliesTo and scopeFiles is empty", async () => {
    setupCanonical([{ fileName: "test-rule.md", content: "Test-only rule.", appliesTo: ["test/**/*.test.ts"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: [] });
    expect(result.scopingReport?.appliesToInertCount).toBe(1);
  });

  test("AC8: returns scopingReport.appliesToInertCount 0 when scopeFiles is non-empty", async () => {
    setupCanonical([{ fileName: "test-rule.md", content: "Test-only rule.", appliesTo: ["test/**/*.test.ts"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["test/unit/foo.test.ts"] });
    expect(result.scopingReport?.appliesToInertCount).toBe(0);
  });

  test("AC9: returns a scopingReport.stageFilteredIds containing the ID of a stage-filtered rule", async () => {
    setupCanonical([{ fileName: "stage-only.md", content: "Plan-only rule.", stages: ["plan"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    expect(result.scopingReport?.stageFilteredIds).toContain("stage-only");
  });

  test("AC10: returns a scopingReport.appliesToFilteredIds containing the ID of an appliesTo-filtered rule", async () => {
    setupCanonical([{ fileName: "test-rule.md", content: "Test-only rule.", appliesTo: ["test/**/*.test.ts"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles: ["src/foo.ts"] });
    expect(result.scopingReport?.appliesToFilteredIds).toContain("test-rule");
  });

  test("AC11: returns scopingReport.scopeFileCount equal to request.scopeFiles length", async () => {
    setupCanonical([{ fileName: "global-stage.md", content: "Applies everywhere." }]);
    const provider = new StaticRulesProvider();
    const scopeFiles = ["a.ts", "b.ts", "c.ts"];
    const result = await provider.fetch({ ...BASE_REQUEST, scopeFiles });
    expect(result.scopingReport?.scopeFileCount).toBe(scopeFiles.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12: budgetPressure unaffected by scoping
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — budgetPressure unaffected by scoping filters", () => {
  test("AC12: returns budgetPressure unaffected by rules removed by either scoping filter", async () => {
    // Only a stage-filtered rule exists; it never reaches budget accounting,
    // so there is nothing for the budget to report pressure about.
    setupCanonical([{ fileName: "stage-only.md", content: "Plan-only rule.", stages: ["plan"] }]);
    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    expect(result.chunks).toHaveLength(0);
    expect(result.budgetPressure).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13: orchestrator manifest propagation
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator.assemble() — scopingReport propagation", () => {
  test("AC13: static-rules manifest providerResults entry carries the provider's scopingReport", async () => {
    setupCanonical([{ fileName: "test-rule.md", content: "Test-only rule.", appliesTo: ["test/**/*.test.ts"] }]);
    const provider = new StaticRulesProvider();
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      providerIds: ["static-rules"],
      scopeFiles: [],
    });
    const entry = bundle.manifest.providerResults?.find((pr) => pr.providerId === "static-rules");

    expect(entry).toBeDefined();
    expect(entry?.scopingReport?.appliesToInertCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zero-rule exits stay observable
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — zero-rule exits", () => {
  test("#558 package-filter drop still returns a scopingReport", async () => {
    // Every other exit from this provider carries a scopingReport. Omitting it
    // here made "rules existed but the package filter rejected all of them" the
    // one scoping outcome invisible to manifest telemetry.
    // Repo-level only: the package has no rules of its own, so the paths:
    // filter is the sole reason nothing survives.
    _staticRulesDeps.loadCanonicalRules = async (dir: string) =>
      dir === "/project"
        ? [{ id: "api-only", fileName: "api-only.md", content: "## R\nbody", paths: ["packages/api/**"] }]
        : [];

    const result = await new StaticRulesProvider().fetch({
      ...BASE_REQUEST,
      repoRoot: "/project",
      packageDir: "/project/packages/web",
      scopeFiles: ["src/a.ts"],
    });

    expect(result.chunks).toEqual([]);
    expect(result.scopingReport).toBeDefined();
    expect(result.scopingReport?.sectionCount).toBe(0);
    expect(result.scopingReport?.scopeFileCount).toBe(1);
  });

  test("stage filtering to empty reports the stage cause, not a budget cause", async () => {
    // Conflating the two sends an operator to tune a budget that was never the
    // problem.
    setupCanonical([
      { id: "review-only", fileName: "review-only.md", content: "## R\nbody", stages: ["review"] },
    ]);

    const result = await new StaticRulesProvider({ enforceBudget: true }).fetch({
      ...BASE_REQUEST,
      stage: "execution",
    });

    expect(result.chunks).toEqual([]);
    expect(result.scopingReport?.stageFilteredIds).toEqual(["review-only"]);
    expect(result.scopingReport?.sectionCount).toBe(0);
    // Nothing was dropped by the budget — there was nothing to drop.
    expect(result.budgetPressure).toBeUndefined();
  });
});
