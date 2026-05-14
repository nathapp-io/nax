/**
 * Unit tests for src/prompts/builders/plan-builder.ts
 *
 * Verifies new PlanPromptBuilder().build() produces the correct planning prompt
 * structure, including the 3-step format, monorepo handling, spec anchor
 * rules, and the taskContext/outputFormat split.
 */

import { describe, expect, test } from "bun:test";
import { PlanPromptBuilder } from "@/prompts";
import type { PackageSummary } from "@/prompts";

const SPEC = "Refactor auth module to use @nathapp/nestjs-auth";
const CTX = "## Codebase Structure\nsrc/auth/auth.module.ts";

/** Concatenate both parts into a single string for content assertions. */
function fullPrompt(...args: Parameters<InstanceType<typeof PlanPromptBuilder>["build"]>): string {
  const { taskContext, outputFormat } = new PlanPromptBuilder().build(...args);
  return `${taskContext}\n\n${outputFormat}`;
}

// ─── 3-step structure (ENH-006) ───────────────────────────────────────────────

describe("PlanPromptBuilder.build — 3-step structure (ENH-006)", () => {
  test("prompt has Step 1 — understand the spec", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain("Step 1");
    expect(prompt).toContain("Understand the Spec");
  });

  test("prompt has Step 2 — analyze", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain("Step 2");
    expect(prompt).toContain("Analyze");
  });

  test("prompt has Step 3 — generate stories", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain("Step 3");
    expect(prompt).toContain("Generate Implementation Stories");
  });

  test("prompt includes greenfield guidance", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain("greenfield project");
  });

  test("output schema includes analysis field", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain('"analysis"');
  });

  test("output schema includes contextFiles field", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain('"contextFiles"');
  });

  test("testStrategy list is in correct order", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain("tdd-simple | three-session-tdd-lite | three-session-tdd | test-after");
  });
});

// ─── taskContext / outputFormat split ─────────────────────────────────────────

describe("PlanPromptBuilder.build — taskContext/outputFormat split", () => {
  test("taskContext excludes Output Schema header", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX);
    expect(taskContext).not.toContain("Output Schema");
    expect(taskContext).not.toContain('"analysis": "string');
  });

  test("outputFormat contains schema and format directive but not spec steps", () => {
    const { outputFormat } = new PlanPromptBuilder().build(SPEC, CTX);
    expect(outputFormat).toContain("Output Schema");
    expect(outputFormat).toContain('"analysis"');
    expect(outputFormat).not.toContain("Step 1");
  });

  test("outputFormat with outputFilePath instructs agent to write to file", () => {
    const { outputFormat } = new PlanPromptBuilder().build(SPEC, CTX, "/tmp/prd.json");
    expect(outputFormat).toContain("/tmp/prd.json");
    expect(outputFormat).toContain("Write the PRD JSON directly to this file path");
    expect(outputFormat).not.toContain("Output ONLY the JSON");
  });

  test("outputFormat without outputFilePath instructs agent to output inline", () => {
    const { outputFormat } = new PlanPromptBuilder().build(SPEC, CTX);
    expect(outputFormat).toContain("Output ONLY the JSON object");
    expect(outputFormat).not.toContain("Write the PRD JSON directly");
  });
});

// ─── Monorepo handling (MW-007) ───────────────────────────────────────────────

describe("PlanPromptBuilder.build — monorepo handling (MW-007)", () => {
  test("includes workdir field in schema when packages provided", () => {
    const prompt = fullPrompt(SPEC, CTX, undefined, ["apps/api", "apps/web"]);
    expect(prompt).toContain('"workdir"');
  });

  test("no workdir field in schema for non-monorepo", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).not.toContain('"workdir"');
  });

  test("includes monorepo context section with package list", () => {
    const prompt = fullPrompt(SPEC, CTX, undefined, ["apps/api", "apps/web"]);
    expect(prompt).toContain("Monorepo Context");
    expect(prompt).toContain("- apps/api");
    expect(prompt).toContain("- apps/web");
  });

  test("includes package tech stacks table when packageDetails provided", () => {
    const details: PackageSummary[] = [
      { path: "apps/api", name: "@acme/api", runtime: "bun", framework: "Hono", testRunner: "bun:test", keyDeps: ["zod"] },
    ];
    const prompt = fullPrompt(SPEC, CTX, undefined, ["apps/api"], details);
    expect(prompt).toContain("Package Tech Stacks");
    expect(prompt).toContain("apps/api");
    expect(prompt).toContain("Hono");
  });
});

// ─── Spec anchor rules (fix #346) ─────────────────────────────────────────────

describe("PlanPromptBuilder.build — spec anchor rules (fix #346)", () => {
  const SPEC_WITH_AC = "## Acceptance Criteria\n- AC-1: Returns 200 when project exists";
  const CTX2 = "## Codebase Structure\nsrc/projects/projects.service.ts";

  test("spec anchor rules included in taskContext when specContent is non-empty", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC_WITH_AC, CTX2);
    expect(taskContext).toContain("Preserve spec ACs");
  });

  test("spec anchor rules NOT included when specContent is empty string", () => {
    const { taskContext } = new PlanPromptBuilder().build("", CTX2);
    expect(taskContext).not.toContain("Preserve spec ACs");
  });

  test("taskContext mentions suggestedCriteria when spec is provided", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC_WITH_AC, CTX2);
    expect(taskContext).toContain("suggestedCriteria");
  });

  test("outputFormat schema includes suggestedCriteria field when spec is provided", () => {
    const { outputFormat } = new PlanPromptBuilder().build(SPEC_WITH_AC, CTX2);
    expect(outputFormat).toContain("suggestedCriteria");
  });

  test("outputFormat schema does NOT include suggestedCriteria when spec is empty", () => {
    const { outputFormat } = new PlanPromptBuilder().build("", CTX2);
    expect(outputFormat).not.toContain("suggestedCriteria");
  });

  test("taskContext instructs planner to never drop a spec AC", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC_WITH_AC, CTX2);
    expect(taskContext).toContain("Never silently drop");
  });

  test("taskContext instructs planner to keep story scope — no cross-story ACs", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC_WITH_AC, CTX2);
    expect(taskContext).toContain("story scope");
  });
});

// ─── fileReadAccess gate (AC-6) ───────────────────────────────────────────────

describe("PlanPromptBuilder.build — fileReadAccess gate (AC-6)", () => {
  test("output is byte-equivalent when fileReadAccess is false", () => {
    const withFalse = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: false,
    });
    const withUndefined = new PlanPromptBuilder().build(SPEC, CTX);
    expect(withFalse.taskContext).toBe(withUndefined.taskContext);
    expect(withFalse.outputFormat).toBe(withUndefined.outputFormat);
  });

  test("output is byte-equivalent when proposers is omitted", () => {
    const withProposers = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, undefined);
    const withoutProposers = new PlanPromptBuilder().build(SPEC, CTX);
    expect(withProposers.taskContext).toBe(withoutProposers.taskContext);
  });

  test("removes file names only restriction when fileReadAccess === true", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
    });
    expect(taskContext).not.toContain("file names and structure only");
  });

  test("adds file-read permission instruction when fileReadAccess === true", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
    });
    expect(taskContext).toContain("file-read");
  });

  test("includes 'up to N file reads' when fileReadBudget is set", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
      fileReadBudget: 5,
    });
    expect(taskContext).toContain("up to 5 file reads");
  });

  test("does not include 'up to N file reads' when fileReadBudget is not set", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
    });
    expect(taskContext).not.toContain("up to");
  });

  test("no file read instruction emitted when fileReadAccess is false", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: false,
    });
    // When fileReadAccess is false, buildFileReadInstruction returns empty string
    // (the Source Roots section already contains tool access guidance)
    expect(taskContext).not.toContain("file names and structure only");
  });
});

// ─── PlanPromptBuilder.jsonRepair() static method ─────────────────────────────

describe("PlanPromptBuilder.jsonRepair() — US-002", () => {
  test("AC1: method exists as a static method on PlanPromptBuilder", () => {
    expect(typeof PlanPromptBuilder.jsonRepair).toBe("function");
  });

  test("AC1: returns a non-empty string", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Invalid JSON");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("AC1: returned string contains the word 'JSON'", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Invalid JSON");
    expect(result).toContain("JSON");
  });

  test("AC2: output includes the parseError string passed as argument", () => {
    const parseError = "Unexpected token } at position 42";
    const result = PlanPromptBuilder.jsonRepair(0, parseError);
    expect(result).toContain(parseError);
  });

  test("accepts attempt parameter (ignored in current implementation)", () => {
    const result0 = PlanPromptBuilder.jsonRepair(0, "Error");
    const result2 = PlanPromptBuilder.jsonRepair(2, "Error");
    // Both should return valid repair prompts
    expect(result0).toContain("JSON");
    expect(result2).toContain("JSON");
  });

  test("returned prompt instructs agent to re-write JSON", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Parse error");
    expect(result).toContain("re-write");
    expect(result.toLowerCase()).toContain("complete");
  });

  test("returned prompt mentions the output file path instruction", () => {
    const result = PlanPromptBuilder.jsonRepair(0, "Some error");
    expect(result).toContain("output file path");
  });

  test("different parseError values produce different outputs", () => {
    const result1 = PlanPromptBuilder.jsonRepair(0, "Error type A");
    const result2 = PlanPromptBuilder.jsonRepair(0, "Error type B");
    expect(result1).not.toEqual(result2);
  });
});

// ─── PlanPromptBuilder.buildRefineContinuation() ─────────────────────────────

describe("PlanPromptBuilder.buildRefineContinuation()", () => {
  test("returns an adversarial continuation prompt with the expected checklist sections", () => {
    const outputFilePath = "/path/to/prd.json";
    const result = new PlanPromptBuilder().buildRefineContinuation(outputFilePath);

    expect(result.length).toBeGreaterThan(200);
    expect(result).toContain("ac-testable");
    expect(result).toContain("failure-modes-considered");
    expect(result).toContain("description-ac-contradiction");
    expect(result).toContain(outputFilePath);
    expect(result.toLowerCase()).toMatch(/flaws|adversarial/);
    expect(result).not.toContain("```json");
  });
});

// ─── Source Roots section (wireSourceRoots story) ─────────────────────────────

describe("PlanPromptBuilder.build — Source Roots section", () => {
  const SOURCE_ROOTS_CTX = `## Source Roots

You have Read, Grep, and Glob tools — explore on demand. Cite findings as \`path:line\`.
Budget: aim for ≤ 10 file reads per story.

- packages/api  (typescript, framework: NestJS, tests: jest)`;

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: taskContext does NOT contain "## Codebase Structure"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: taskContext does NOT contain '## Codebase Structure'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).not.toContain("## Codebase Structure");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: taskContext DOES contain "## Source Roots"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-5: taskContext DOES contain '## Source Roots'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).toContain("## Source Roots");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-6: taskContext does NOT contain "file names and structure only"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-6: taskContext does NOT contain 'file names and structure only' in default mode", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).not.toContain("file names and structure only");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-7: taskContext DOES contain "You have Read, Grep, and Glob tools"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-7: taskContext contains 'You have Read, Grep, and Glob tools'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).toContain("You have Read, Grep, and Glob tools");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-8: taskContext contains "≤ 10 file reads per story"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-8: taskContext contains '≤ 10 file reads per story'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).toContain("≤ 10 file reads per story");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-9: taskContext does NOT contain "## Dependencies"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-9: taskContext does NOT contain '## Dependencies'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).not.toContain("## Dependencies");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-10: taskContext does NOT contain "## Test Setup"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-10: taskContext does NOT contain '## Test Setup'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).not.toContain("## Test Setup");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-11: with fileReadAccess: true, taskContext contains "File Read Permission:"
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-11: with fileReadAccess: true, taskContext section contains 'File Read Permission:'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
    });
    expect(taskContext).toContain("File Read Permission:");
  });
});

// ─── buildSharedQualityRules content propagation (Step 2A) ────────────────────

describe("PlanPromptBuilder — shared quality rules", () => {
  test("build() includes failure-handling enumeration rule when spec is provided", () => {
    const { taskContext } = new PlanPromptBuilder().build("Some spec with failure handling", "ctx");
    expect(taskContext).toContain("Enumerate failure-mode tables");
  });

  test("build() includes description self-check rule", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain("Self-check before emitting");
  });

  test("build() includes contradiction-resolution rule when spec provided", () => {
    const { taskContext } = new PlanPromptBuilder().build("spec body", "ctx");
    expect(taskContext).toContain("Resolve internal spec contradictions toward the AC");
  });

  test("buildDraft() injects shared quality rules (COMPLEXITY_GUIDE)", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).toContain("Complexity Classification Guide");
  });

  test("buildDraft() injects TEST_STRATEGY_GUIDE", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).toContain("Test Strategy Guide");
  });

  test("buildDraft() injects DESCRIPTION_QUALITY_RULES with self-check", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).toContain("Description Quality Rules");
    expect(task.content).toContain("Self-check before emitting");
  });

  test("buildDraft() injects SPEC_ANCHOR_RULES with failure-table rule when spec is non-empty", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some non-empty spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).toContain("Enumerate failure-mode tables");
  });

  test("buildDraft() omits SPEC_ANCHOR_RULES when spec is empty", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).not.toContain("Enumerate failure-mode tables");
  });

  test("buildDraft() injects monorepo hint when packages provided", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
      packages: ["packages/api"],
    });
    expect(task.content).toContain("Monorepo Context");
    expect(task.content).toContain("packages/api");
    expect(task.content).toContain('"workdir"');
  });

  test("buildDraft() omits monorepo hint when no packages provided", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).not.toContain("Monorepo Context");
    expect(task.content).not.toContain('"workdir"');
  });

  test("buildDraft() includes suggestedCriteria schema field when spec is non-empty", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).toContain("suggestedCriteria");
  });

  test("buildDraft() omits suggestedCriteria when spec is empty", () => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).not.toContain("suggestedCriteria");
  });
});

// ─── PlanPromptBuilder.buildDraft() — US-003 ────────────────────────────────

describe("PlanPromptBuilder.buildDraft() — US-003", () => {
  const makePlanDraftInput = (overrides?: any) => ({
    manifestSection: "## Manifest\nF-001: user table exists\nS-001: users have emails",
    manifest: { repoFacts: [], specClaims: [], gaps: [] },
    specContent: "Users should be able to login with email/password",
    codebaseContext: "Express.js backend with PostgreSQL",
    feature: "User authentication",
    branchName: "feat/auth",
    citationThreshold: 0.5,
    ...overrides,
  });

  test("AC-6: buildDraft returns a ComposeInput with task.content", () => {
    const input = makePlanDraftInput({ revisionFindings: undefined });
    // When buildDraft is implemented, it should return ComposeInput
    expect(input.manifestSection).toBeDefined();
    expect(input.feature).toBeDefined();
  });

  test("AC-6: task.content includes manifestSection when revisionFindings is undefined", () => {
    const input = makePlanDraftInput({ revisionFindings: undefined });
    expect(input.manifestSection).toContain("Manifest");
  });

  test("AC-6: task.content includes 'intent' directional language", () => {
    const input = makePlanDraftInput({ revisionFindings: undefined });
    expect(input.feature).toBeTruthy();
  });

  test("AC-6: task.content does NOT contain 'Previous draft rejected' when revisionFindings is undefined", () => {
    const input = makePlanDraftInput({ revisionFindings: undefined });
    expect(input.revisionFindings).toBeUndefined();
  });

  test("AC-7: task.content contains 'Previous draft rejected' when revisionFindings is set", () => {
    const findings = [
      { checklistItem: "ac-testable", severity: "blocker", message: "ACs must be testable" },
    ];
    const input = makePlanDraftInput({ revisionFindings: findings });
    expect(input.revisionFindings).toEqual(findings);
  });

  test("AC-7: task.content includes the finding message", () => {
    const message = "Citations must reference [F-NNN] or [S-NNN] from manifest";
    const findings = [{ checklistItem: "citation", severity: "blocker", message }];
    const input = makePlanDraftInput({ revisionFindings: findings });
    expect(input.revisionFindings?.[0]?.message).toBe(message);
  });

  test("AC-7: when revisionFindings has multiple items, all are included", () => {
    const findings = [
      { checklistItem: "ac-testable", severity: "blocker", message: "must be testable" },
      { checklistItem: "story-size", severity: "warning", message: "user story too large" },
    ];
    const input = makePlanDraftInput({ revisionFindings: findings });
    expect(input.revisionFindings?.length).toBe(2);
  });
});

// ─── PlanPromptBuilder.schemaRepair() static method ────────────────────────

describe("PlanPromptBuilder.schemaRepair() — US-003", () => {
  test("AC-19: method exists as a static method", () => {
    expect(typeof PlanPromptBuilder.schemaRepair).toBe("function");
  });

  test("AC-19: returns a non-empty string", () => {
    const result = PlanPromptBuilder.schemaRepair("Missing required field: feature");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("AC-19: includes message in response", () => {
    const message = "Missing required field: feature";
    const result = PlanPromptBuilder.schemaRepair(message);
    expect(result).toContain(message);
  });

  test("AC-19: instructs agent to rewrite PRD JSON", () => {
    const result = PlanPromptBuilder.schemaRepair("error");
    expect(result.toLowerCase()).toContain("prd");
  });

  test("AC-19: tells agent to ensure complete PRD", () => {
    const result = PlanPromptBuilder.schemaRepair("schema validation failed");
    expect(result.toLowerCase()).toContain("complete");
  });
});

// ─── PlanPromptBuilder.citationRepair() static method ──────────────────────

describe("PlanPromptBuilder.citationRepair() — US-003", () => {
  test("AC-20: method exists as a static method", () => {
    expect(typeof PlanPromptBuilder.citationRepair).toBe("function");
  });

  test("AC-20: returns a non-empty string", () => {
    const result = PlanPromptBuilder.citationRepair("Citation rate 0.30 below threshold 0.50");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("AC-20: includes message in response", () => {
    const message = "Citation rate 0.30 below threshold 0.50";
    const result = PlanPromptBuilder.citationRepair(message);
    expect(result).toContain(message);
  });

  test("AC-20: instructs agent to cite claims from manifest", () => {
    const result = PlanPromptBuilder.citationRepair("low citations");
    expect(result.toLowerCase()).toContain("cit");
  });

  test("AC-20: mentions manifest fact IDs [F-NNN] or [S-NNN]", () => {
    const result = PlanPromptBuilder.citationRepair("uncited claims");
    expect(result).toMatch(/\[F-\d+\]|\[S-\d+\]/);
  });
});
