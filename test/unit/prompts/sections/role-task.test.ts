import { describe, expect, test } from "bun:test";
import { buildRoleTaskSection } from "../../../../src/prompts/sections/role-task";

describe("buildRoleTaskSection — implementer role", () => {
  test.each([
    ["standard says 'make failing tests pass'", "standard", "make failing tests pass"],
    ["standard says 'Do NOT modify test files'", "standard", "Do NOT modify test files"],
    ["standard includes explicit git commit -m instruction", "standard", "git commit -m"],
    ["standard includes commit instruction with feat: prefix", "standard", "feat: <description>"],
    ["lite acknowledges test-writer session", "lite", "test-writer session"],
    ["lite says 'implement'", "lite", "implement"],
    ["lite includes explicit git commit -m instruction", "lite", "git commit -m"],
    ["lite includes commit instruction with feat: prefix", "lite", 'feat: <description>'],
  ])("%s", (_label, variant, needle) => {
    const result = buildRoleTaskSection("implementer", variant as "standard" | "lite");
    expect(result).toContain(needle);
  });

  test("standard and lite have different content", () => {
    const standard = buildRoleTaskSection("implementer", "standard");
    const lite = buildRoleTaskSection("implementer", "lite");
    expect(standard).not.toEqual(lite);
  });

  test("defaults to standard variant when no variant provided", () => {
    const defaultResult = buildRoleTaskSection("implementer");
    const standardResult = buildRoleTaskSection("implementer", "standard");
    expect(defaultResult).toEqual(standardResult);
  });
});

describe("buildRoleTaskSection — test-writer role", () => {
  test("mentions tests, not git commit, and implies failing/red phase", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result.toLowerCase()).toMatch(/test/);
    expect(result).not.toContain("git commit");
    expect(result.toLowerCase()).toMatch(/fail|red|not yet implemented/);
  });
});

describe("buildRoleTaskSection — verifier role", () => {
  test("mentions verification, excludes new-test instructions, includes TDD handoff integrity and gate language", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result.toLowerCase()).toMatch(/verif|review|check|inspect/);
    expect(result).not.toContain("Write tests first");
    expect(result).toContain("TDD handoff integrity");
    expect(result).toContain("Do NOT perform semantic acceptance review");
    expect(result).toContain("attempted the full-suite gate");
    expect(result).toContain("may have passed, failed, or exhausted rectification");
    expect(result).not.toContain("confirmed it passes");
  });
});

describe("buildRoleTaskSection — single-session role", () => {
  test("mentions tests, implementation, and includes git commit instruction", () => {
    const result = buildRoleTaskSection("single-session");
    expect(result.toLowerCase()).toMatch(/test/);
    expect(result.toLowerCase()).toMatch(/implement/);
    expect(result).toContain("git commit");
  });
});

// ---------------------------------------------------------------------------
// BP-001: batch role tests (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — batch role", () => {
  test("TDD-aligned: no test-after, implements stories in order, commits per story, git commit, verification", () => {
    const result = buildRoleTaskSection("batch");
    expect(result.toLowerCase()).toMatch(/write.*test|test.*first|tdd/);
    expect(result.toLowerCase()).not.toContain("test-after");
    expect(result.toLowerCase()).toMatch(/each story|in order|story.*order/);
    expect(result.toLowerCase()).toMatch(/commit.*story|story.*commit/);
    expect(result.toLowerCase()).toMatch(/story.*id|id.*commit/);
    expect(result).toContain("git commit");
    expect(result.toLowerCase()).toMatch(/verif|run.*test|test.*pass/);
  });

  test.each([
    ["default bun test command", "bun test", "Bun test"],
    ["custom pytest testCommand", "pytest", "pytest"],
  ])("includes test framework hint for %s", (_label, cmd, expected) => {
    const result = buildRoleTaskSection("batch", undefined, cmd);
    expect(result).toContain(expected);
  });

  test("is distinct from single-session and tdd-simple roles", () => {
    const batch = buildRoleTaskSection("batch");
    expect(batch).not.toEqual(buildRoleTaskSection("single-session"));
    expect(batch).not.toEqual(buildRoleTaskSection("tdd-simple"));
  });
});

// ---------------------------------------------------------------------------
// TS-002: tdd-simple role tests (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — tdd-simple role", () => {
  test("write-failing-first, red/green phases, refactor, git commit, no test-file prohibition", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result).toContain("Write failing tests FIRST");
    expect(result.toLowerCase()).toMatch(/red phase|confirm.*fail|run.*test.*fail/);
    expect(result.toLowerCase()).toMatch(/green phase|implement.*pass|minimum.*code/);
    expect(result.toLowerCase()).toContain("refactor");
    expect(result).toContain("git commit -m");
    expect(result).toContain("feat: <description>");
    expect(result).not.toContain("Do NOT modify test files");
  });

  test("is distinct from single-session and test-writer roles", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tddSimple = buildRoleTaskSection("tdd-simple" as any);
    expect(tddSimple).not.toEqual(buildRoleTaskSection("single-session"));
    expect(tddSimple).not.toEqual(buildRoleTaskSection("test-writer"));
  });

  test("mentions red-green-refactor workflow phases", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result.toLowerCase()).toMatch(/red/);
    expect(result.toLowerCase()).toMatch(/green/);
  });
});
