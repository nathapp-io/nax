import { describe, expect, test } from "bun:test";
import { buildRoleTaskSection } from "../../../../src/prompts/sections/role-task";

describe("buildRoleTaskSection — implementer role", () => {
  test("standard variant says 'make failing tests pass'", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("make failing tests pass");
  });

  test("standard variant says 'Do NOT modify test files'", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("Do NOT modify test files");
  });

  test("standard variant includes explicit git commit -m instruction", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("git commit -m");
  });

  test("standard variant includes commit instruction with feat: prefix", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain('feat: <description>');
  });

  test("lite variant acknowledges test-writer session", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain("test-writer session");
  });

  test("lite variant says 'implement'", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain("implement");
  });

  test("lite variant includes explicit git commit -m instruction", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain("git commit -m");
  });

  test("lite variant includes commit instruction with feat: prefix", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain('feat: <description>');
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
  test("mentions writing tests", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result.toLowerCase()).toMatch(/test/);
  });

  test("does not mention git commit", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result).not.toContain("git commit");
  });

  test("mentions failing tests or red phase", () => {
    const result = buildRoleTaskSection("test-writer");
    // test-writer produces failing tests by design
    expect(result.toLowerCase()).toMatch(/fail|red|not yet implemented/);
  });
});

describe("buildRoleTaskSection — verifier role", () => {
  test("mentions verification or review", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result.toLowerCase()).toMatch(/verif|review|check|inspect/);
  });

  test("does not mention writing new tests", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result).not.toContain("Write tests first");
  });

  test("keeps semantic acceptance review out of verifier role", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result).toContain("TDD handoff integrity");
    expect(result).toContain("Do NOT perform semantic acceptance review");
  });

  test("does not claim the full-suite gate already passed", () => {
    const result = buildRoleTaskSection("verifier");
    expect(result).toContain("attempted the full-suite gate");
    expect(result).toContain("may have passed, failed, or exhausted rectification");
    expect(result).not.toContain("confirmed it passes");
  });
});

describe("buildRoleTaskSection — single-session role", () => {
  test("mentions both tests and implementation", () => {
    const result = buildRoleTaskSection("single-session");
    expect(result.toLowerCase()).toMatch(/test/);
    expect(result.toLowerCase()).toMatch(/implement/);
  });

  test("includes git commit instruction", () => {
    const result = buildRoleTaskSection("single-session");
    expect(result).toContain("git commit");
  });
});

// ---------------------------------------------------------------------------
// BP-001: batch role tests (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — batch role", () => {
  test("uses TDD-aligned language: instructs to write tests before implementing", () => {
    const result = buildRoleTaskSection("batch");
    // Must use TDD-aligned language, not "test-after"
    expect(result.toLowerCase()).toMatch(/write.*test|test.*first|tdd/);
  });

  test("does NOT contain 'test-after' language", () => {
    const result = buildRoleTaskSection("batch");
    expect(result.toLowerCase()).not.toContain("test-after");
  });

  test("instructs to implement each story in order", () => {
    const result = buildRoleTaskSection("batch");
    expect(result.toLowerCase()).toMatch(/each story|in order|story.*order/);
  });

  test("instructs to commit each story separately with story ID in commit message", () => {
    const result = buildRoleTaskSection("batch");
    expect(result.toLowerCase()).toMatch(/commit.*story|story.*commit/);
    expect(result.toLowerCase()).toMatch(/story.*id|id.*commit/);
  });

  test("includes git commit instruction", () => {
    const result = buildRoleTaskSection("batch");
    expect(result).toContain("git commit");
  });

  test("includes test framework hint for default bun test command", () => {
    const result = buildRoleTaskSection("batch", undefined, "bun test");
    expect(result).toContain("Bun test");
  });

  test("includes test framework hint from custom testCommand", () => {
    const result = buildRoleTaskSection("batch", undefined, "pytest");
    expect(result).toContain("pytest");
  });

  test("is distinct from single-session role", () => {
    const batch = buildRoleTaskSection("batch");
    const singleSession = buildRoleTaskSection("single-session");
    expect(batch).not.toEqual(singleSession);
  });

  test("is distinct from tdd-simple role", () => {
    const batch = buildRoleTaskSection("batch");
    const tddSimple = buildRoleTaskSection("tdd-simple");
    expect(batch).not.toEqual(tddSimple);
  });

  test("mentions verification (run tests after implementing)", () => {
    const result = buildRoleTaskSection("batch");
    expect(result.toLowerCase()).toMatch(/verif|run.*test|test.*pass/);
  });
});

// ---------------------------------------------------------------------------
// TS-002: tdd-simple role tests (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — tdd-simple role", () => {
  test("instructs to write failing tests FIRST for acceptance criteria", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result).toContain("Write failing tests FIRST");
  });

  test("instructs to confirm tests fail (red phase)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result.toLowerCase()).toMatch(/red phase|confirm.*fail|run.*test.*fail/);
  });

  test("instructs to implement minimum code to make tests pass (green phase)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result.toLowerCase()).toMatch(/green phase|implement.*pass|minimum.*code/);
  });

  test("instructs to refactor while keeping tests green", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result.toLowerCase()).toContain("refactor");
  });

  test("includes git commit instruction", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result).toContain("git commit -m");
  });

  test("includes commit instruction with feat: prefix", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result).toContain("feat: <description>");
  });

  test("does NOT say 'Do NOT modify test files' (agent can modify both)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result).not.toContain("Do NOT modify test files");
  });

  test("is distinct from single-session role", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tddSimple = buildRoleTaskSection("tdd-simple" as any);
    const singleSession = buildRoleTaskSection("single-session");
    expect(tddSimple).not.toEqual(singleSession);
  });

  test("is distinct from test-writer role", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tddSimple = buildRoleTaskSection("tdd-simple" as any);
    const testWriter = buildRoleTaskSection("test-writer");
    expect(tddSimple).not.toEqual(testWriter);
  });

  test("mentions red-green-refactor workflow phases", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    // Must mention at least the red and green phases
    expect(result.toLowerCase()).toMatch(/red/);
    expect(result.toLowerCase()).toMatch(/green/);
  });
});
