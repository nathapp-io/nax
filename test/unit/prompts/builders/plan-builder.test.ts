/**
 * Unit tests for src/prompts/builders/plan-builder.ts
 *
 * Verifies new PlanPromptBuilder().build() produces the correct planning prompt
 * structure, including the 3-step format, monorepo handling, spec anchor
 * rules, and the taskContext/outputFormat split.
 */

import { describe, expect, test } from "bun:test";
import { PlanPromptBuilder } from "../../../../src/prompts";
import type { PackageSummary } from "../../../../src/prompts";

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
