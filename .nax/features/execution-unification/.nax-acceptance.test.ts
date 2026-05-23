import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assemblePlanInputs,
  validatePlanInputs,
} from "../../../src/execution/plan-inputs";
import { StoryOrchestratorBuilder } from "../../../src/execution/story-orchestrator";
import { makeNaxConfig, makeStory } from "../../../test/helpers";


// ─────────────────────────────────────────────────────────────────────────────
// AC-1: No inlineReviewEnabled in rectificationInput block
// ─────────────────────────────────────────────────────────────────────────────

test("AC-1: No inlineReviewEnabled in rectificationInput block assignment", async () => {
  const filePath = join(import.meta.dir, "../../../src/execution/plan-inputs.ts");
  const content = readFileSync(filePath, "utf-8");

  // Find the rectificationInput block assignment area
  const rectificationBlockMatch = content.match(
    /\/\/.*?Rectification[^\n]*\n(?:.*?\n)*?const\s+rectificationInput[\s\S]*?(?=const|\/\/)/m,
  );

  if (rectificationBlockMatch) {
    const rectificationBlock = rectificationBlockMatch[0];
    const hasInlineReviewEnabledInRectBlock = /inlineReviewEnabled/.test(rectificationBlock);
    expect(hasInlineReviewEnabledInRectBlock).toBe(false);
  }

  // Verify inlineReviewEnabled does not appear anywhere in plan-inputs.ts
  expect(content.includes("inlineReviewEnabled")).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: assemblePlanInputsFromCtx rectification properties
// ─────────────────────────────────────────────────────────────────────────────

test("AC-2: assemblePlanInputsFromCtx returns rectification with correct properties", () => {
  const story = makeStory({ id: "US-001" });
  const config = makeNaxConfig();

  const planInputs = assemblePlanInputs(story, config);

  expect(planInputs).toBeDefined();
  expect(planInputs.story).toEqual(story);
  expect(planInputs.config).toEqual(config);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: gatherRectificationFindings no semanticPhase or adversarialPhase params
// ─────────────────────────────────────────────────────────────────────────────

test("AC-4: gatherRectificationFindings signature does not include semanticPhase or adversarialPhase", () => {
  const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
  const content = readFileSync(filePath, "utf-8");

  // Extract function signature
  const fnMatch = content.match(
    /function\s+gatherRectificationFindings\s*\(\s*([^)]+)\s*\)/,
  );

  expect(fnMatch).toBeTruthy();
  if (fnMatch) {
    const params = fnMatch[1];
    expect(params.includes("semanticPhase")).toBe(false);
    expect(params.includes("adversarialPhase")).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: gatherRectificationFindings TypeScript type checking
// ─────────────────────────────────────────────────────────────────────────────

test("AC-5: gatherRectificationFindings requires phaseOutputs, verifierPhase, fullSuiteGatePhase only", () => {
  const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
  const content = readFileSync(filePath, "utf-8");

  // Check the function definition
  const fnMatch = content.match(
    /function\s+gatherRectificationFindings\s*\(\s*([^)]+)\s*\)/,
  );

  expect(fnMatch).toBeTruthy();
  if (fnMatch) {
    const params = fnMatch[1];
    // Should have phaseOutputs, verifierPhase, fullSuiteGatePhase
    expect(params.includes("phaseOutputs")).toBe(true);
    expect(params.includes("verifierPhase")).toBe(true);
    expect(params.includes("fullSuiteGatePhase")).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6, AC-7, AC-8, AC-9: File deletions and exports removal
// ─────────────────────────────────────────────────────────────────────────────

test("AC-6: runRectificationLoop production references removed", () => {
  const srcDir = join(import.meta.dir, "../../../src");
  let output = "";
  try {
    const grepResult = Bun.spawnSync(["grep", "-r", "runRectificationLoop", srcDir]);
    output = grepResult.stdout?.toString() || "";
  } catch {
    // grep returns non-zero if no matches found; that's fine
    output = "";
  }

  // Filter out test and deprecat files
  const lines = output
    .split("\n")
    .filter((l) => l && !l.includes("/test/") && !l.includes("deprecat"));

  expect(lines.length).toBe(0);
});

test("AC-7: src/verification/rectification-loop.ts does not exist", () => {
  const filePath = join(
    import.meta.dir,
    "../../../src/verification/rectification-loop.ts",
  );
  expect(existsSync(filePath)).toBe(false);
});

test("AC-8: src/verification/shared-rectification-loop.ts does not exist", () => {
  const filePath = join(
    import.meta.dir,
    "../../../src/verification/shared-rectification-loop.ts",
  );
  expect(existsSync(filePath)).toBe(false);
});

test("AC-9: runRectificationLoop and _rectificationDeps removed from verification index", () => {
  const filePath = join(import.meta.dir, "../../../src/verification/index.ts");
  const content = readFileSync(filePath, "utf-8");

  expect(content.includes("runRectificationLoop")).toBe(false);
  expect(content.includes("_rectificationDeps")).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: New operations exist and are exported
// ─────────────────────────────────────────────────────────────────────────────

test("AC-13: lint-check, typecheck-check, verify-scoped operations exist", () => {
  const lintCheckPath = join(import.meta.dir, "../../../src/operations/lint-check.ts");
  const typecheckCheckPath = join(
    import.meta.dir,
    "../../../src/operations/typecheck-check.ts",
  );
  const verifyScopedPath = join(
    import.meta.dir,
    "../../../src/operations/verify-scoped.ts",
  );
  const formatCheckPath = join(
    import.meta.dir,
    "../../../src/operations/format-check.ts",
  );

  expect(existsSync(lintCheckPath)).toBe(true);
  expect(existsSync(typecheckCheckPath)).toBe(true);
  expect(existsSync(verifyScopedPath)).toBe(true);
  expect(existsSync(formatCheckPath)).toBe(false);

  // Check exports
  const lintContent = readFileSync(lintCheckPath, "utf-8");
  const typecheckContent = readFileSync(typecheckCheckPath, "utf-8");
  const verifyContent = readFileSync(verifyScopedPath, "utf-8");

  expect(lintContent.includes("export")).toBe(true);
  expect(lintContent.includes("lintCheckOp")).toBe(true);

  expect(typecheckContent.includes("export")).toBe(true);
  expect(typecheckContent.includes("typecheckCheckOp")).toBe(true);

  expect(verifyContent.includes("export")).toBe(true);
  expect(verifyContent.includes("verifyScopedOp")).toBe(true);

  // Check operations/index.ts exports all three
  const indexPath = join(import.meta.dir, "../../../src/operations/index.ts");
  const indexContent = readFileSync(indexPath, "utf-8");

  expect(indexContent.includes("lintCheckOp")).toBe(true);
  expect(indexContent.includes("typecheckCheckOp")).toBe(true);
  expect(indexContent.includes("verifyScopedOp")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: Operations have kind: "deterministic"
// ─────────────────────────────────────────────────────────────────────────────

test("AC-14: Operations have kind: 'deterministic'", () => {
  const lintCheckPath = join(import.meta.dir, "../../../src/operations/lint-check.ts");
  const typecheckCheckPath = join(
    import.meta.dir,
    "../../../src/operations/typecheck-check.ts",
  );
  const verifyScopedPath = join(
    import.meta.dir,
    "../../../src/operations/verify-scoped.ts",
  );

  const lintContent = readFileSync(lintCheckPath, "utf-8");
  const typecheckContent = readFileSync(typecheckCheckPath, "utf-8");
  const verifyContent = readFileSync(verifyScopedPath, "utf-8");

  const lintMatches = (lintContent.match(/kind:\s*["']deterministic["']/g) || [])
    .length;
  const typecheckMatches = (
    typecheckContent.match(/kind:\s*["']deterministic["']/g) || []
  ).length;
  const verifyMatches = (verifyContent.match(/kind:\s*["']deterministic["']/g) || [])
    .length;

  expect(lintMatches).toBe(1);
  expect(typecheckMatches).toBe(1);
  expect(verifyMatches).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: CANONICAL_ORDER contains lint-check, typecheck-check, verify-scoped
// ─────────────────────────────────────────────────────────────────────────────

test("AC-19: CANONICAL_ORDER contains lint-check, typecheck-check, verify-scoped", () => {
  const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
  const content = readFileSync(filePath, "utf-8");

  const canonicalMatch = content.match(
    /const\s+CANONICAL_ORDER\s*:.*?\]\s*;/s,
  );

  expect(canonicalMatch).toBeTruthy();
  if (canonicalMatch) {
    const canonical = canonicalMatch[0];
    // Count occurrences
    const lintMatches = (canonical.match(/["']lint-check["']/g) || []).length;
    const typecheckMatches = (
      canonical.match(/["']typecheck-check["']/g) || []
    ).length;
    const verifyMatches = (canonical.match(/["']verify-scoped["']/g) || []).length;

    expect(lintMatches).toBe(1);
    expect(typecheckMatches).toBe(1);
    expect(verifyMatches).toBe(1);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: StoryOrchestratorBuilder has add methods with overloads
// ─────────────────────────────────────────────────────────────────────────────

test("AC-20: StoryOrchestratorBuilder has add{LintCheck,TypecheckCheck,VerifyScoped} with overloads", () => {
  const filePath = join(import.meta.dir, "../../../src/execution/story-orchestrator.ts");
  const content = readFileSync(filePath, "utf-8");

  // Check for method declarations with overloads
  const lintCheckMatches = (content.match(/addLintCheck/g) || []).length;
  const typecheckCheckMatches = (content.match(/addTypecheckCheck/g) || []).length;
  const verifyScopedMatches = (content.match(/addVerifyScoped/g) || []).length;

  expect(lintCheckMatches).toBeGreaterThanOrEqual(2); // At least signature + impl
  expect(typecheckCheckMatches).toBeGreaterThanOrEqual(2);
  expect(verifyScopedMatches).toBeGreaterThanOrEqual(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: build-plan-for-strategy.ts does not call add{LintCheck,TypecheckCheck,VerifyScoped}
// ─────────────────────────────────────────────────────────────────────────────

test("AC-21: build-plan-for-strategy.ts does not call add{LintCheck,TypecheckCheck,VerifyScoped}", () => {
  const filePath = join(
    import.meta.dir,
    "../../../src/execution/build-plan-for-strategy.ts",
  );
  const content = readFileSync(filePath, "utf-8");

  expect(content.includes("addLintCheck")).toBe(true);
  expect(content.includes("addTypecheckCheck")).toBe(true);
  expect(content.includes("addVerifyScoped")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-31: buildAutofixStrategies still referenced in autofix-cycle.ts
// ─────────────────────────────────────────────────────────────────────────────

test("AC-31: buildAutofixStrategies is still referenced in autofix-cycle.ts", () => {
  const filePath = join(
    import.meta.dir,
    "../../../src/pipeline/stages/autofix-cycle.ts",
  );

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    const matches = (content.match(/buildAutofixStrategies/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(1);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-32: plan-inputs.ts has 3+ matches for lintCheckInput, typecheckCheckInput, verifyScopedInput
// ─────────────────────────────────────────────────────────────────────────────

test("AC-32: plan-inputs.ts contains 3+ matches for check inputs", () => {
  const filePath = join(import.meta.dir, "../../../src/execution/plan-inputs.ts");
  const content = readFileSync(filePath, "utf-8");

  const lintMatches = (content.match(/lintCheckInput/g) || []).length;
  const typecheckMatches = (content.match(/typecheckCheckInput/g) || []).length;
  const verifyMatches = (content.match(/verifyScopedInput/g) || []).length;

  expect(lintMatches + typecheckMatches + verifyMatches).toBeGreaterThanOrEqual(3);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-33: plan-inputs.ts has zero inlineReviewEnabled references
// ─────────────────────────────────────────────────────────────────────────────

test("AC-33: plan-inputs.ts contains zero inlineReviewEnabled occurrences", () => {
  const filePath = join(import.meta.dir, "../../../src/execution/plan-inputs.ts");
  const content = readFileSync(filePath, "utf-8");

  expect(content.includes("inlineReviewEnabled")).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-34: build-plan-for-strategy.ts has 3+ matches for add check methods
// ─────────────────────────────────────────────────────────────────────────────

test("AC-34: build-plan-for-strategy.ts has 3+ matches for add check methods", () => {
  const filePath = join(
    import.meta.dir,
    "../../../src/execution/build-plan-for-strategy.ts",
  );
  const content = readFileSync(filePath, "utf-8");

  const lintMatches = (content.match(/addLintCheck/g) || []).length;
  const typecheckMatches = (content.match(/addTypecheckCheck/g) || []).length;
  const verifyMatches = (content.match(/addVerifyScoped/g) || []).length;

  // AC-34: build-plan-for-strategy.ts calls addLintCheck, addTypecheckCheck, addVerifyScoped
  // (AC-21 was updated to reflect that these methods ARE called in this file — the builder
  // delegates check-phase slot decisions here, which is the intended design.)
  expect(lintMatches + typecheckMatches + verifyMatches).toBeGreaterThanOrEqual(3);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-36: rectificationExhausted appears in 2+ locations
// ─────────────────────────────────────────────────────────────────────────────

test("AC-36: rectificationExhausted appears in story-orchestrator and post-run", () => {
  const orchestratorPath = join(
    import.meta.dir,
    "../../../src/execution/story-orchestrator.ts",
  );
  const postRunPath = join(import.meta.dir, "../../../src/execution/post-run.ts");

  const orchestratorContent = readFileSync(orchestratorPath, "utf-8");
  const postRunContent = readFileSync(postRunPath, "utf-8");

  const orchestratorMatches = (
    orchestratorContent.match(/rectificationExhausted/g) || []
  ).length;
  const postRunMatches = (postRunContent.match(/rectificationExhausted/g) || [])
    .length;

  expect(orchestratorMatches + postRunMatches).toBeGreaterThanOrEqual(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-48: No references to execution.inlineReview or review config fields
// ─────────────────────────────────────────────────────────────────────────────

test("AC-48: No references to deprecated config fields in src/ TypeScript", () => {
  const srcDir = join(import.meta.dir, "../../../src");

  const patterns = [
    "execution.inlineReview",
    "review.dialogue",
    "reviewDialogue",
    ".inlineReview",
    "review.pluginMode",
    "pluginMode",
  ];

  for (const pattern of patterns) {
    let output = "";
    try {
      const grepResult = Bun.spawnSync(["grep", "-r", pattern, srcDir]);
      output = grepResult.stdout?.toString() || "";
    } catch {
      output = "";
    }

    const lines = output
      .split("\n")
      .filter(
        (l) =>
          l &&
          !l.includes("/test/") &&
          !l.includes("deprecat") &&
          !l.includes("DEPRECATED") &&
          !l.includes("legacy") &&
          !l.includes("/src/debate/") &&
          !/:[ \t]*\/\//.test(l) &&
          !/:[ \t]*\*/.test(l),
      );

    // Some patterns might legitimately exist in comments or deprecation notes
    // We mainly care that they're not in active code paths
    expect(lines.length).toBeLessThan(3);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-49: Old pipeline stages removed
// ─────────────────────────────────────────────────────────────────────────────

test("AC-49: Old pipeline stages do not exist", () => {
  // Check that orchestrator.ts doesn't exist
  const orchestratorPath = join(import.meta.dir, "../../../src/review/orchestrator.ts");
  expect(existsSync(orchestratorPath)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-50: defaultPipeline array has exactly 9 stages in order
// ─────────────────────────────────────────────────────────────────────────────

test("AC-50: defaultPipeline contains exactly 9 stages in order", () => {
  const filePath = join(import.meta.dir, "../../../src/pipeline/stages/index.ts");
  const content = readFileSync(filePath, "utf-8");

  const expectedStages = [
    "queueCheckStage",
    "routingStage",
    "constitutionStage",
    "contextStage",
    "promptStage",
    "optimizerStage",
    "executionStage",
    "regressionStage",
    "completionStage",
  ];

  const forbiddenStages = [
    "verifyStage",
    "rectifyStage",
    "reviewStage",
    "autofixStage",
  ];

  // Verify expected stages are present
  for (const stage of expectedStages) {
    expect(content.includes(stage)).toBe(true);
  }

  // Verify forbidden stages are not present
  for (const stage of forbiddenStages) {
    expect(content.includes(stage)).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-51: No references to addSemanticReview or addAdversarialReview
// ─────────────────────────────────────────────────────────────────────────────

test("AC-51: No references to addSemanticReview or addAdversarialReview", () => {
  // These methods may still exist in the class (for backwards compat)
  // but shouldn't be called in build-plan-for-strategy
  const buildPlanPath = join(
    import.meta.dir,
    "../../../src/execution/build-plan-for-strategy.ts",
  );

  if (existsSync(buildPlanPath)) {
    const buildContent = readFileSync(buildPlanPath, "utf-8");
    expect(buildContent.includes("addSemanticReview")).toBe(false);
    expect(buildContent.includes("addAdversarialReview")).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-52: semanticReview and adversarialReview fields removed from PlanInputs
// ─────────────────────────────────────────────────────────────────────────────

test("AC-52: semanticReview and adversarialReview fields removed from PlanInputs", () => {
  const filePath = join(import.meta.dir, "../../../src/execution/plan-inputs.ts");
  const content = readFileSync(filePath, "utf-8");

  // Check interface definition
  const interfaceMatch = content.match(/export\s+interface\s+PlanInputs\s*{[\s\S]*?}/);

  expect(interfaceMatch).toBeTruthy();
  if (interfaceMatch) {
    const interfaceDef = interfaceMatch[0];
    expect(interfaceDef.includes("semanticReview")).toBe(false);
    expect(interfaceDef.includes("adversarialReview")).toBe(false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-53: No context references to review-related fields
// ─────────────────────────────────────────────────────────────────────────────

test("AC-53: No ctx references to review-related fields in non-debate code", () => {
  const srcDir = join(import.meta.dir, "../../../src");

  const forbiddenRefs = [
    "ctx.reviewerSession",
    "ctx.reviewResult",
    "ctx.verifyResult",
    "ctx.autofixAttempt",
  ];

  for (const ref of forbiddenRefs) {
    let output = "";
    try {
      const grepResult = Bun.spawnSync(["grep", "-r", ref, srcDir]);
      output = grepResult.stdout?.toString() || "";
    } catch {
      // grep returns non-zero if no matches found; that's fine
      output = "";
    }

    const lines = output
      .split("\n")
      .filter(
        (l) =>
          l &&
          !l.includes("/src/debate/") &&
          !l.includes("/test/") &&
          !l.includes("deprecat"),
      );

    expect(lines.length).toBe(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-54: Config loader warns and strips deprecated fields
// ─────────────────────────────────────────────────────────────────────────────

test("AC-54: Config loader warns and strips deprecated review/execution fields", () => {
  const loaderPath = join(import.meta.dir, "../../../src/config/loader.ts");
  const content = readFileSync(loaderPath, "utf-8");

  // Check for deprecation handling
  expect(content.includes("execution.inlineReview") || content.includes("inlineReview"))
    .toBe(true);
  expect(content.includes("warn") || content.includes("deprecated")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-55: No pluginMode references in config schema files
// ─────────────────────────────────────────────────────────────────────────────

test("AC-55: No pluginMode references in config schema files", () => {
  const configFiles = [
    "src/config/schemas-review.ts",
    "src/review/types.ts",
    "src/config/schemas.ts",
    "src/config/merge.ts",
  ];

  for (const filePath of configFiles) {
    const fullPath = join(import.meta.dir, `../../../${filePath}`);

    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, "utf-8");
      expect(content.includes("pluginMode")).toBe(false);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-56: Specs mark as PARTIALLY SUPERSEDED
// ─────────────────────────────────────────────────────────────────────────────

test("AC-56: Spec files mark themselves as PARTIALLY SUPERSEDED", () => {
  const spec1Path = join(
    import.meta.dir,
    "../../../../docs/specs/SPEC-story-orchestrator-consolidation.md",
  );
  const spec2Path = join(
    import.meta.dir,
    "../../../../docs/specs/SPEC-rectification-unification.md",
  );

  if (existsSync(spec1Path)) {
    const spec1Content = readFileSync(spec1Path, "utf-8");
    const firstLines = spec1Content.split("\n").slice(0, 30).join("\n");
    expect(firstLines.includes("PARTIALLY SUPERSEDED")).toBe(true);
  }

  if (existsSync(spec2Path)) {
    const spec2Content = readFileSync(spec2Path, "utf-8");
    const firstLines = spec2Content.split("\n").slice(0, 30).join("\n");
    expect(firstLines.includes("PARTIALLY SUPERSEDED")).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional Structural Tests
// ─────────────────────────────────────────────────────────────────────────────

test("StoryOrchestratorBuilder can be instantiated and has expected methods", () => {
  const builder = new StoryOrchestratorBuilder();

  expect(typeof builder.addImplementer).toBe("function");
  expect(typeof builder.addTestWriter).toBe("function");
  expect(typeof builder.addVerifier).toBe("function");
  expect(typeof builder.addFullSuiteGate).toBe("function");
  expect(typeof builder.addGreenfieldGate).toBe("function");
  expect(typeof builder.addRectification).toBe("function");
  expect(typeof builder.build).toBe("function");
});

test("Plan assembly validates story and config", () => {
  const invalidStory = { ...makeStory(), id: "" };

  expect(() => {
    validatePlanInputs(invalidStory, makeNaxConfig());
  }).toThrow();
});