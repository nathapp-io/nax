import { describe, expect, test } from "bun:test";
import { buildRoleTaskSection } from "../../../../src/prompts/sections/role-task";

// ---------------------------------------------------------------------------
// AC-1: implementer standard
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — implementer standard", () => {
  test("(a) contains 'Read every failing test in scope' before any workflow Implement step", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    const readIdx = result.indexOf("Read every failing test in scope");
    // Find "Implement" appearing as a numbered workflow step (e.g. "2. Implement" or "3. Implement")
    const implStepIdx = result.search(/\d+\.\s+Implement/);
    expect(readIdx).toBeGreaterThan(-1);
    expect(implStepIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeLessThan(implStepIdx);
  });

  test("(b) does NOT contain 'src/' as a directory reference", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).not.toMatch(/\bsrc\//);
  });

  test("(c) lists three test-modification exceptions inline without forward-referencing rectification prompt", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("lint-only");
    expect(result).toContain("contract drift");
    expect(result).toContain("sibling");
    expect(result.toLowerCase()).not.toContain("rectification prompt");
  });

  test("(d) when storyId passed, commit uses feat(<storyId>): format", () => {
    const result = buildRoleTaskSection("implementer", "standard", undefined, undefined, undefined, "story-42");
    expect(result).toContain("feat(story-42):");
  });

  test("(d) when no storyId, commit falls back to feat: <description>", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("feat: <description>");
  });

  test("contains 'make failing tests pass' intent", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result.toLowerCase()).toMatch(/make.*failing.*test|failing.*test.*pass/);
  });

  test("contains git commit -m instruction", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("git commit -m");
  });

  test("contains Do NOT modify test files", () => {
    const result = buildRoleTaskSection("implementer", "standard");
    expect(result).toContain("Do NOT modify test files");
  });
});

// ---------------------------------------------------------------------------
// AC-2: implementer lite
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — implementer lite", () => {
  test("(a) defines 'stub' concretely", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    // Must describe what a stub is: type declaration, throw-not-implemented, const placeholder
    expect(result.toLowerCase()).toMatch(/type.*(declaration|interface)|throw.*not.?implement|const.*placeholder/i);
  });

  test("(b) instructs agent to add tests for uncovered AC", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result.toLowerCase()).toMatch(/ac|coverage|uncovered|no test/i);
    // More specifically: instructs to add tests if AC has no test
    expect(result).toMatch(/[Ii]f.*[Aa][Cc].*no test|add.*test.*[Aa][Cc]|[Aa][Cc].*no.*test/);
  });

  test("(c) does NOT contain 'src/' or 'test/' as directory references", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).not.toMatch(/\bsrc\//);
    expect(result).not.toMatch(/\btest\//);
  });

  test("acknowledges test-writer session", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result.toLowerCase()).toMatch(/test.?writer.*session|session.*test.?writer/);
  });

  test("contains git commit -m instruction", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).toContain("git commit -m");
  });
});

// ---------------------------------------------------------------------------
// AC-3: test-writer strict (isolation undefined or "strict")
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — test-writer strict", () => {
  test.each([
    ["isolation=undefined (defaults to strict)", undefined],
    ["isolation=strict explicit", "strict"],
  ] as const)("%s: (a) does NOT contain 'test/' as a directory reference", (_label, iso) => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, iso);
    expect(result).not.toMatch(/\btest\//);
  });

  test.each([
    ["isolation=undefined", undefined],
    ["isolation=strict", "strict"],
  ] as const)("%s: (b) contains ASSERTION failure and NOT import error verify-RED instruction", (_label, iso) => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, iso);
    expect(result).toMatch(/ASSERTION failure/i);
    expect(result).toMatch(/NOT.*import error/i);
  });

  test.each([
    ["isolation=undefined", undefined],
    ["isolation=strict", "strict"],
  ] as const)("%s: (c) instructs covering success + boundary/failure paths per AC", (_label, iso) => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, iso);
    expect(result.toLowerCase()).toMatch(/success.*(path|test)|boundary|failure.*(path|test)/);
  });

  test.each([
    ["isolation=undefined", undefined],
    ["isolation=strict", "strict"],
  ] as const)("%s: (d) instructs AC-ID prefixing in test names", (_label, iso) => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, iso);
    // Should mention AC IDs in test names e.g. 'AC4: ...'
    expect(result).toMatch(/AC[\d]|ac.*id|test name.*AC|AC.*prefix/i);
  });

  test("mentions tests, implies failing/red phase", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result.toLowerCase()).toMatch(/test/);
    expect(result.toLowerCase()).toMatch(/fail|red|not yet implemented/);
  });

  test("does not instruct git commit (test-writer writes no implementation)", () => {
    const result = buildRoleTaskSection("test-writer");
    expect(result).not.toContain("git commit");
  });
});

// ---------------------------------------------------------------------------
// AC-4: test-writer lite (isolation="lite")
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — test-writer lite", () => {
  test("(a) hard-caps stub body at 3 lines", () => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, "lite");
    expect(result).toMatch(/3 lines|three lines|≤\s*3|no more than 3/i);
  });

  test("(b) contains verify-RED instruction with 'compile AND fail'", () => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, "lite");
    expect(result.toLowerCase()).toMatch(/compile.*and.*fail|compile.*fail/);
  });

  test("is distinct from strict test-writer", () => {
    const lite = buildRoleTaskSection("test-writer", undefined, undefined, "lite");
    const strict = buildRoleTaskSection("test-writer", undefined, undefined, "strict");
    expect(lite).not.toEqual(strict);
  });
});

// ---------------------------------------------------------------------------
// AC-5: single-session
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — single-session", () => {
  test("contains test-writing workflow steps AND implementation steps AND verify-RED", () => {
    const result = buildRoleTaskSection("single-session");
    // Test-writing steps
    expect(result.toLowerCase()).toMatch(/test/);
    // Implementation steps
    expect(result.toLowerCase()).toMatch(/implement/);
    // Verify RED — assertion failures not import errors
    expect(result).toMatch(/ASSERTION failure/i);
    expect(result).toMatch(/NOT.*import error/i);
  });

  test("contains git commit instruction", () => {
    const result = buildRoleTaskSection("single-session");
    expect(result).toContain("git commit");
  });
});

// ---------------------------------------------------------------------------
// AC-6: tdd-simple
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — tdd-simple", () => {
  test("names RED, GREEN, REFACTOR phases", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result.toUpperCase()).toMatch(/RED/);
    expect(result.toUpperCase()).toMatch(/GREEN/);
    expect(result.toLowerCase()).toMatch(/refactor/);
  });

  test("contains verify-RED (assertion failures NOT import errors)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result).toMatch(/ASSERTION failure/i);
    expect(result).toMatch(/NOT.*import error/i);
  });

  test("contains git commit -m instruction", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = buildRoleTaskSection("tdd-simple" as any);
    expect(result).toContain("git commit -m");
  });

  test("is distinct from single-session and test-writer roles", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tddSimple = buildRoleTaskSection("tdd-simple" as any);
    expect(tddSimple).not.toEqual(buildRoleTaskSection("single-session"));
    expect(tddSimple).not.toEqual(buildRoleTaskSection("test-writer"));
  });
});

// ---------------------------------------------------------------------------
// AC-7: batch
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — batch", () => {
  test("contains verify-RED per-story (assertion failures NOT import errors)", () => {
    const result = buildRoleTaskSection("batch");
    expect(result).toMatch(/assertion failure/i);
    expect(result).toMatch(/NOT.*import error/i);
  });

  test("contains feat(<story-id>): commit format", () => {
    const result = buildRoleTaskSection("batch");
    expect(result).toContain("feat(<story-id>):");
  });

  test("TDD-aligned: write tests first, commit per story, with story ID", () => {
    const result = buildRoleTaskSection("batch");
    expect(result.toLowerCase()).toMatch(/write.*test|test.*first|tdd/);
    expect(result.toLowerCase()).not.toContain("test-after");
    expect(result.toLowerCase()).toMatch(/each story|in order|story.*order/);
    expect(result.toLowerCase()).toMatch(/commit.*story|story.*commit/);
    expect(result.toLowerCase()).toMatch(/story.*id|id.*commit/);
    expect(result).toContain("git commit");
  });

  test.each([
    ["default bun test command", "bun test", "Bun test"],
    ["custom pytest testCommand", "pytest", "pytest"],
  ] as const)("includes test framework hint for %s", (_label, cmd, expected) => {
    const result = buildRoleTaskSection("batch", undefined, cmd);
    expect(result).toContain(expected);
  });

  test("is distinct from single-session and tdd-simple roles", () => {
    const batch = buildRoleTaskSection("batch");
    expect(batch).not.toEqual(buildRoleTaskSection("single-session"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(batch).not.toEqual(buildRoleTaskSection("tdd-simple" as any));
  });
});

// ---------------------------------------------------------------------------
// AC-8: no-test and verifier — unchanged
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection — no-test", () => {
  test("does not require test modifications, includes git commit", () => {
    const result = buildRoleTaskSection("no-test");
    expect(result.toLowerCase()).toMatch(/no.*test|test.*not.*required/);
    expect(result).toContain("git commit");
  });

  test("includes custom justification when provided", () => {
    const result = buildRoleTaskSection("no-test", undefined, undefined, undefined, "config-only change");
    expect(result).toContain("config-only change");
  });
});

describe("buildRoleTaskSection — verifier", () => {
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

// ---------------------------------------------------------------------------
// AC-9: No hardcoded directory references for any role
// ---------------------------------------------------------------------------

describe("AC-9: No hardcoded src/, test/, test/unit/, test/integration/ path references", () => {
  const roles: Parameters<typeof buildRoleTaskSection>[0][] = [
    "implementer",
    "test-writer",
    "verifier",
    "single-session",
    "tdd-simple",
    "batch",
    "no-test",
  ];

  test.each(roles)("role '%s' (standard/default) has no hardcoded directory references", (role) => {
    const result = buildRoleTaskSection(role as Parameters<typeof buildRoleTaskSection>[0]);
    expect(result).not.toMatch(/\bsrc\//);
    expect(result).not.toMatch(/\btest\/unit\//);
    expect(result).not.toMatch(/\btest\/integration\//);
  });

  test("implementer lite has no hardcoded directory references", () => {
    const result = buildRoleTaskSection("implementer", "lite");
    expect(result).not.toMatch(/\bsrc\//);
    expect(result).not.toMatch(/\btest\//);
    expect(result).not.toMatch(/\btest\/unit\//);
    expect(result).not.toMatch(/\btest\/integration\//);
  });

  test("test-writer strict has no hardcoded test/ directory references", () => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, "strict");
    expect(result).not.toMatch(/\btest\//);
  });

  test("test-writer lite has no hardcoded test/ directory references", () => {
    const result = buildRoleTaskSection("test-writer", undefined, undefined, "lite");
    expect(result).not.toMatch(/\btest\//);
  });
});

// ---------------------------------------------------------------------------
// AC-10: storyId plumbing
// ---------------------------------------------------------------------------

describe("AC-10: storyId plumbing for commit format", () => {
  test.each([
    ["implementer standard with storyId", "implementer", "standard", "story-123", "feat(story-123):"],
    ["implementer lite with storyId", "implementer", "lite", "story-abc", "feat(story-abc):"],
    ["single-session with storyId", "single-session", undefined, "ss-99", "feat(ss-99):"],
    ["tdd-simple with storyId", "tdd-simple", undefined, "ts-7", "feat(ts-7):"],
  ] as const)("%s", (_label, role, variant, storyId, expected) => {
    const result = buildRoleTaskSection(
      role as Parameters<typeof buildRoleTaskSection>[0],
      variant as "standard" | "lite" | undefined,
      undefined,
      undefined,
      undefined,
      storyId,
    );
    expect(result).toContain(expected);
  });

  test.each([
    ["implementer standard no storyId", "implementer", "standard"],
    ["implementer lite no storyId", "implementer", "lite"],
    ["single-session no storyId", "single-session", undefined],
  ] as const)("%s falls back to feat: <description>", (_label, role, variant) => {
    const result = buildRoleTaskSection(
      role as Parameters<typeof buildRoleTaskSection>[0],
      variant as "standard" | "lite" | undefined,
    );
    expect(result).toContain("feat: <description>");
    expect(result).not.toMatch(/feat\([^)]+\):/);
  });

  test("empty storyId falls back to feat: <description>", () => {
    const result = buildRoleTaskSection("implementer", "standard", undefined, undefined, undefined, "");
    // empty string should be treated as no storyId
    expect(result).toContain("feat: <description>");
  });
});

// ---------------------------------------------------------------------------
// Backwards-compatibility: old API (variant-only)
// ---------------------------------------------------------------------------

describe("backwards-compat: old API buildRoleTaskSection('standard'/'lite')", () => {
  test("buildRoleTaskSection('standard') equals buildRoleTaskSection('implementer', 'standard')", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildRoleTaskSection("standard" as any)).toEqual(buildRoleTaskSection("implementer", "standard"));
  });

  test("buildRoleTaskSection('lite') equals buildRoleTaskSection('implementer', 'lite')", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildRoleTaskSection("lite" as any)).toEqual(buildRoleTaskSection("implementer", "lite"));
  });

  test("defaults to standard variant when no variant provided", () => {
    const defaultResult = buildRoleTaskSection("implementer");
    const standardResult = buildRoleTaskSection("implementer", "standard");
    expect(defaultResult).toEqual(standardResult);
  });

  test("standard and lite have different content", () => {
    const standard = buildRoleTaskSection("implementer", "standard");
    const lite = buildRoleTaskSection("implementer", "lite");
    expect(standard).not.toEqual(lite);
  });
});
