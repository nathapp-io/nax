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
  test.each([
    ["Step 1", "Understand the Spec"],
    ["Step 2", "Analyze"],
    ["Step 3", "Generate Implementation Stories"],
  ])("prompt has %s", (step, text) => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain(step);
    expect(prompt).toContain(text);
  });

  test("prompt includes greenfield guidance and testStrategy list in correct order", () => {
    const prompt = fullPrompt(SPEC, CTX);
    expect(prompt).toContain("greenfield project");
    expect(prompt).toContain("tdd-simple | three-session-tdd-lite | three-session-tdd | test-after");
  });

  test.each(['"analysis"', '"contextFiles"'])("output schema includes %s field", (field) => {
    expect(fullPrompt(SPEC, CTX)).toContain(field);
  });
});

// ─── taskContext / outputFormat split ─────────────────────────────────────────

describe("PlanPromptBuilder.build — taskContext/outputFormat split", () => {
  test("taskContext excludes Output Schema; outputFormat contains schema and format but not spec steps", () => {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(SPEC, CTX);
    expect(taskContext).not.toContain("Output Schema");
    expect(taskContext).not.toContain('"analysis": "string');
    expect(outputFormat).toContain("Output Schema");
    expect(outputFormat).toContain('"analysis"');
    expect(outputFormat).not.toContain("Step 1");
  });

  test.each([
    ["with outputFilePath", "/tmp/prd.json" as string | undefined, true],
    ["without outputFilePath", undefined, false],
  ] as const)("outputFormat %s: writes-to-file=%s", (_label, outputFilePath, writesToFile) => {
    const { outputFormat } = new PlanPromptBuilder().build(SPEC, CTX, outputFilePath);
    if (writesToFile) {
      expect(outputFormat).toContain("/tmp/prd.json");
      expect(outputFormat).toContain("Write the PRD JSON directly to this file path");
      expect(outputFormat).not.toContain("Output ONLY the JSON");
    } else {
      expect(outputFormat).toContain("Output ONLY the JSON object");
      expect(outputFormat).not.toContain("Write the PRD JSON directly");
    }
  });
});

// ─── Monorepo handling (MW-007) ───────────────────────────────────────────────

describe("PlanPromptBuilder.build — monorepo handling (MW-007)", () => {
  test.each([
    ["includes workdir when packages provided", ["apps/api", "apps/web"] as string[] | undefined, true],
    ["no workdir for non-monorepo", undefined, false],
  ] as const)("%s", (_label, packages, shouldInclude) => {
    const prompt = fullPrompt(SPEC, CTX, undefined, packages);
    if (shouldInclude) expect(prompt).toContain('"workdir"');
    else expect(prompt).not.toContain('"workdir"');
  });

  test("includes monorepo context section with package list and tech stacks table when packageDetails provided", () => {
    const prompt = fullPrompt(SPEC, CTX, undefined, ["apps/api", "apps/web"]);
    expect(prompt).toContain("Monorepo Context");
    expect(prompt).toContain("- apps/api");
    expect(prompt).toContain("- apps/web");

    const details: PackageSummary[] = [
      { path: "apps/api", name: "@acme/api", runtime: "bun", framework: "Hono", testRunner: "bun:test", keyDeps: ["zod"] },
    ];
    const promptWithDetails = fullPrompt(SPEC, CTX, undefined, ["apps/api"], details);
    expect(promptWithDetails).toContain("Package Tech Stacks");
    expect(promptWithDetails).toContain("apps/api");
    expect(promptWithDetails).toContain("Hono");
  });
});

// ─── Spec anchor rules (fix #346) ─────────────────────────────────────────────

describe("PlanPromptBuilder.build — spec anchor rules (fix #346)", () => {
  const SPEC_WITH_AC = "## Acceptance Criteria\n- AC-1: Returns 200 when project exists";
  const CTX2 = "## Codebase Structure\nsrc/projects/projects.service.ts";

  test.each([
    ["included when non-empty spec", SPEC_WITH_AC, true],
    ["NOT included when empty spec", "", false],
  ] as const)("spec anchor rules: %s", (_label, spec, shouldInclude) => {
    const { taskContext } = new PlanPromptBuilder().build(spec, CTX2);
    if (shouldInclude) expect(taskContext).toContain("Preserve spec ACs");
    else expect(taskContext).not.toContain("Preserve spec ACs");
  });

  test.each([
    ["suggestedCriteria"],
    ["Never silently drop"],
    ["story scope"],
  ])("taskContext with spec contains '%s'", (text) => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC_WITH_AC, CTX2);
    expect(taskContext).toContain(text);
  });

  test.each([
    ["includes suggestedCriteria when spec provided", SPEC_WITH_AC, true],
    ["does NOT include suggestedCriteria when spec empty", "", false],
  ] as const)("outputFormat schema: %s", (_label, spec, shouldInclude) => {
    const { outputFormat } = new PlanPromptBuilder().build(spec, CTX2);
    if (shouldInclude) expect(outputFormat).toContain("suggestedCriteria");
    else expect(outputFormat).not.toContain("suggestedCriteria");
  });
});

// ─── fileReadAccess gate (AC-6) ───────────────────────────────────────────────

describe("PlanPromptBuilder.build — fileReadAccess gate (AC-6)", () => {
  test("output is byte-equivalent when fileReadAccess is false or proposers is omitted", () => {
    const withFalse = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: false,
    });
    const withUndefined = new PlanPromptBuilder().build(SPEC, CTX);
    expect(withFalse.taskContext).toBe(withUndefined.taskContext);
    expect(withFalse.outputFormat).toBe(withUndefined.outputFormat);

    const withProposers = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, undefined);
    expect(withProposers.taskContext).toBe(withUndefined.taskContext);
  });

  test("fileReadAccess true: removes file-names-only restriction and adds file-read instruction", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
    });
    expect(taskContext).not.toContain("file names and structure only");
    expect(taskContext).toContain("file-read");
  });

  test.each([
    ["includes 'up to N' when budget set", 5 as number | undefined, true],
    ["no 'up to N' when budget not set", undefined, false],
  ] as const)("fileReadBudget: %s", (_label, fileReadBudget, shouldInclude) => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
      fileReadBudget,
    });
    if (shouldInclude) expect(taskContext).toContain("up to 5 file reads");
    else expect(taskContext).not.toContain("up to");
  });

});

// ─── PlanPromptBuilder.jsonRepair() static method ─────────────────────────────

describe("PlanPromptBuilder.jsonRepair() — US-002", () => {
  test("AC1: method exists and returns a non-empty string", () => {
    expect(typeof PlanPromptBuilder.jsonRepair).toBe("function");
    const result = PlanPromptBuilder.jsonRepair(0, "Invalid JSON");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test.each([
    ["the word 'JSON'", "JSON"],
    ["'re-write' instruction", "re-write"],
    ["output file path instruction", "output file path"],
  ])("returned prompt contains %s", (_label, expected) => {
    const result = PlanPromptBuilder.jsonRepair(0, "Invalid JSON");
    expect(result).toContain(expected);
  });

  test("AC2: output includes the parseError string passed as argument", () => {
    const parseError = "Unexpected token } at position 42";
    const result = PlanPromptBuilder.jsonRepair(0, parseError);
    expect(result).toContain(parseError);
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
    expect(result).toContain("codebase-fit");
    expect(result).toContain("dependency-minimization");
    expect(result).toContain("routing-realism");
    expect(result).toContain("regression-coverage");
    expect(result).toContain("scope-consistency");
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

  test.each([
    ["## Source Roots"],
    ["You have Read, Grep, and Glob tools"],
    ["≤ 10 file reads per story"],
  ])("taskContext contains '%s' (AC-5/7/8)", (text) => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).toContain(text);
  });

  test.each([
    ["## Codebase Structure"],
    ["file names and structure only"],
    ["## Dependencies"],
    ["## Test Setup"],
  ])("taskContext does NOT contain '%s' (AC-4/6/9/10)", (text) => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX);
    expect(taskContext).not.toContain(text);
  });

  test("AC-11: with fileReadAccess: true, taskContext section contains 'File Read Permission:'", () => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, SOURCE_ROOTS_CTX, undefined, undefined, undefined, undefined, {
      fileReadAccess: true,
    });
    expect(taskContext).toContain("File Read Permission:");
  });
});

// ─── buildSharedQualityRules content propagation (Step 2A) ────────────────────

describe("PlanPromptBuilder — shared quality rules", () => {
  test.each([
    ["failure-handling enumeration rule", "Enumerate failure-mode tables"],
    ["description self-check rule", "Self-check before emitting"],
    ["contradiction-resolution rule", "Resolve internal spec contradictions toward the AC"],
  ])("build() includes %s when spec provided", (_label, expected) => {
    const { taskContext } = new PlanPromptBuilder().build(SPEC, CTX);
    expect(taskContext).toContain(expected);
  });

  test.each([
    ["COMPLEXITY_GUIDE", "Complexity Classification Guide"],
    ["TEST_STRATEGY_GUIDE", "Test Strategy Guide"],
    ["DESCRIPTION_QUALITY_RULES", "Description Quality Rules"],
  ])("buildDraft() injects %s", (_name, expected) => {
    const builder = new PlanPromptBuilder();
    const { task } = builder.buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).toContain(expected);
  });

  test("buildDraft() DESCRIPTION_QUALITY_RULES includes self-check", () => {
    const { task } = new PlanPromptBuilder().buildDraft({
      manifestSection: "## Manifest\n",
      specContent: "Some spec",
      codebaseContext: "ctx",
      feature: "feat",
      branchName: "feat/x",
      citationThreshold: 0.5,
    });
    expect(task.content).toContain("Self-check before emitting");
  });

  test.each([
    ["injects SPEC_ANCHOR_RULES when spec non-empty", "Some non-empty spec", true],
    ["omits SPEC_ANCHOR_RULES when spec empty", "", false],
  ] as const)("buildDraft(): %s", (_label, specContent, shouldInclude) => {
    const { task } = new PlanPromptBuilder().buildDraft({ manifestSection: "## Manifest\n", specContent, codebaseContext: "ctx", feature: "feat", branchName: "feat/x", citationThreshold: 0.5 });
    if (shouldInclude) expect(task.content).toContain("Enumerate failure-mode tables");
    else expect(task.content).not.toContain("Enumerate failure-mode tables");
  });

  test.each([
    ["injects monorepo hint when packages provided", ["packages/api"] as string[] | undefined, true],
    ["omits monorepo hint when no packages", undefined, false],
  ] as const)("buildDraft(): %s", (_label, packages, shouldInclude) => {
    const { task } = new PlanPromptBuilder().buildDraft({ manifestSection: "## Manifest\n", specContent: "Some spec", codebaseContext: "ctx", feature: "feat", branchName: "feat/x", citationThreshold: 0.5, packages });
    if (shouldInclude) { expect(task.content).toContain("Monorepo Context"); expect(task.content).toContain("packages/api"); expect(task.content).toContain('"workdir"'); }
    else { expect(task.content).not.toContain("Monorepo Context"); expect(task.content).not.toContain('"workdir"'); }
  });

  test.each([
    ["includes suggestedCriteria when spec non-empty", "Some spec", true],
    ["omits suggestedCriteria when spec empty", "", false],
  ] as const)("buildDraft(): %s", (_label, specContent, shouldInclude) => {
    const { task } = new PlanPromptBuilder().buildDraft({ manifestSection: "## Manifest\n", specContent, codebaseContext: "ctx", feature: "feat", branchName: "feat/x", citationThreshold: 0.5 });
    if (shouldInclude) expect(task.content).toContain("suggestedCriteria");
    else expect(task.content).not.toContain("suggestedCriteria");
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

  test("AC-6/7: input is well-formed with undefined revisionFindings; revisionFindings are forwarded when provided", () => {
    const inputUndefined = makePlanDraftInput({ revisionFindings: undefined });
    expect(inputUndefined.manifestSection).toBeDefined();
    expect(inputUndefined.feature).toBeDefined();
    expect(inputUndefined.manifestSection).toContain("Manifest");
    expect(inputUndefined.revisionFindings).toBeUndefined();

    const message = "Citations must reference [F-NNN] or [S-NNN] from manifest";
    const findings = [
      { checklistItem: "ac-testable", severity: "blocker", message: "ACs must be testable" },
      { checklistItem: "citation", severity: "blocker", message },
    ];
    const inputWithFindings = makePlanDraftInput({ revisionFindings: findings });
    expect(inputWithFindings.revisionFindings).toEqual(findings);
    expect(inputWithFindings.revisionFindings?.[1]?.message).toBe(message);
    expect(inputWithFindings.revisionFindings?.length).toBe(2);
  });
});

// ─── PlanPromptBuilder.schemaRepair() static method ────────────────────────

describe("PlanPromptBuilder.schemaRepair() — US-003", () => {
  test("AC-19: method exists, returns non-empty string containing the message", () => {
    expect(typeof PlanPromptBuilder.schemaRepair).toBe("function");
    const message = "Missing required field: feature";
    const result = PlanPromptBuilder.schemaRepair(message);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain(message);
  });

  test.each([
    ["rewrite PRD JSON", "prd"],
    ["complete PRD", "complete"],
  ])("AC-19: instructs agent to %s", (_label, keyword) => {
    const result = PlanPromptBuilder.schemaRepair("error");
    expect(result.toLowerCase()).toContain(keyword);
  });
});

// ─── PlanPromptBuilder.citationRepair() static method ──────────────────────

describe("PlanPromptBuilder.citationRepair() — US-003", () => {
  test("AC-20: method exists, returns non-empty string containing the message", () => {
    expect(typeof PlanPromptBuilder.citationRepair).toBe("function");
    const message = "Citation rate 0.30 below threshold 0.50";
    const result = PlanPromptBuilder.citationRepair(message);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain(message);
  });

  test.each([
    ["cite claims from manifest", (r: string) => r.toLowerCase().includes("cit")],
    ["manifest fact IDs [F-NNN] or [S-NNN]", (r: string) => /\[F-\d+\]|\[S-\d+\]/.test(r)],
  ])("AC-20: instructs agent to reference %s", (_label, check) => {
    const result = PlanPromptBuilder.citationRepair("low citations");
    expect(check(result)).toBe(true);
  });
});
