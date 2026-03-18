import { describe, expect, test } from "bun:test";
import { buildIsolationSection } from "../../../../src/prompts/sections/isolation";

describe("buildIsolationSection — test-writer role", () => {
  test("strict mode forbids src/ modification", () => {
    const result = buildIsolationSection("test-writer", "strict");
    expect(result).toContain("Do NOT modify");
    expect(result).toContain("src/");
    expect(result).not.toContain("MAY read src/");
  });

  test("lite mode allows reading src/", () => {
    const result = buildIsolationSection("test-writer", "lite");
    expect(result).toContain("MAY read src/");
  });

  test("lite mode mentions stubs", () => {
    const result = buildIsolationSection("test-writer", "lite");
    expect(result).toContain("stub");
  });

  test("both modes include test filtering rule", () => {
    const strictResult = buildIsolationSection("test-writer", "strict");
    const liteResult = buildIsolationSection("test-writer", "lite");
    expect(strictResult).toContain("bun test");
    expect(liteResult).toContain("bun test");
  });

  test("defaults to strict mode when no mode provided", () => {
    const defaultResult = buildIsolationSection("test-writer");
    const strictResult = buildIsolationSection("test-writer", "strict");
    expect(defaultResult).toEqual(strictResult);
  });
});

describe("buildIsolationSection — implementer role", () => {
  test("allows modification of src/ files", () => {
    const result = buildIsolationSection("implementer");
    expect(result).toContain("src/");
    expect(result).not.toContain("Do NOT modify");
  });

  test("forbids modification of test files", () => {
    const result = buildIsolationSection("implementer");
    expect(result.toLowerCase()).toMatch(/do not modify.*test|test.*do not modify/i);
  });

  test("includes test filtering rule", () => {
    const result = buildIsolationSection("implementer");
    expect(result).toContain("bun test");
  });
});

describe("buildIsolationSection — verifier role", () => {
  test("allows reading all files", () => {
    const result = buildIsolationSection("verifier");
    expect(result.toLowerCase()).toMatch(/read|inspect|review/);
  });

  test("includes test filtering rule", () => {
    const result = buildIsolationSection("verifier");
    expect(result).toContain("bun test");
  });
});

describe("buildIsolationSection — single-session role", () => {
  test("allows creating files in both test/ and src/", () => {
    const result = buildIsolationSection("single-session");
    expect(result).toContain("test/");
    expect(result).toContain("src/");
  });

  test("includes test filtering rule", () => {
    const result = buildIsolationSection("single-session");
    expect(result).toContain("bun test");
  });
});

// ---------------------------------------------------------------------------
// TS-002: tdd-simple isolation tests (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("buildIsolationSection — tdd-simple role", () => {
  test("does NOT forbid modification of src/ files", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildIsolationSection("tdd-simple" as any);
    expect(result).not.toMatch(/Do NOT modify.*src|Only.*test\//i);
  });

  test("does NOT forbid modification of test/ files", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildIsolationSection("tdd-simple" as any);
    expect(result).not.toMatch(/Do NOT modify.*test|Only.*src\//i);
  });

  test("allows agent to modify both src/ and test/ directories", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildIsolationSection("tdd-simple" as any);
    // Either empty (no restrictions) or explicitly states both are allowed
    const lower = result.toLowerCase();
    const isEmpty = result.trim() === "";
    const allowsBoth =
      (lower.includes("src/") && lower.includes("test/")) ||
      lower.includes("both") ||
      lower.includes("may modify both");
    expect(isEmpty || allowsBoth).toBe(true);
  });

  test("returns empty string or only a permissive note (no restriction block)", () => {
    // The tdd-simple role should have NO isolation restrictions —
    // agent writes tests and implements in the same session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildIsolationSection("tdd-simple" as any);
    // Must NOT contain the strict isolation header text
    expect(result).not.toContain("Only create or modify files in the test/ directory");
    expect(result).not.toContain("Do not modify test files");
  });

  test("is distinct from test-writer strict isolation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tddSimple = buildIsolationSection("tdd-simple" as any);
    const testWriterStrict = buildIsolationSection("test-writer", "strict");
    expect(tddSimple).not.toEqual(testWriterStrict);
  });

  test("is distinct from implementer isolation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tddSimple = buildIsolationSection("tdd-simple" as any);
    const implementer = buildIsolationSection("implementer");
    expect(tddSimple).not.toEqual(implementer);
  });
});
