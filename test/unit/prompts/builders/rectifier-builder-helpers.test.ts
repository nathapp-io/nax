/**
 * Tests for rectifier-builder-helpers — buildEscapeHatch + exceptionCountWord
 *
 * Verifies that the escape-hatch section dynamically matches the story's TDD strategy:
 * - TDD path: 4 exceptions, "four" in count text, includes Exception 4 with both cases
 * - Non-TDD path: 3 exceptions, "three" in count text, excludes Exception 4
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "../../../helpers";
import { buildEscapeHatch, exceptionCountWord } from "../../../../src/prompts/builders/rectifier-builder-helpers";
import { RectifierPromptBuilder } from "../../../../src/prompts";
import type { ReviewCheckResult } from "../../../../src/review/types";

const TDD_STORY = makeStory({
  id: "US-TDD",
  title: "TDD story",
  description: "A story with three-session TDD.",
  acceptanceCriteria: ["AC1"],
  routing: { testStrategy: "three-session-tdd", complexity: "simple", reasoning: "test" },
});

const NO_TEST_STORY = makeStory({
  id: "US-NT",
  title: "No-test story",
  description: "A story without test generation.",
  acceptanceCriteria: ["AC1"],
  routing: { testStrategy: "no-test", complexity: "simple", reasoning: "test" },
});

const TDD_LITE_STORY = makeStory({
  id: "US-LITE",
  title: "TDD-lite story",
  description: "A story with three-session-tdd-lite.",
  acceptanceCriteria: ["AC1"],
  routing: { testStrategy: "three-session-tdd-lite", complexity: "simple", reasoning: "test" },
});

// ─── buildEscapeHatch ─────────────────────────────────────────────────────────

describe("buildEscapeHatch", () => {
  describe("TDD path (includeMockHandoff: true)", () => {
    const hatch = buildEscapeHatch({ includeMockHandoff: true });

    test("says 'four narrow escape valves'", () => {
      expect(hatch).toContain("four narrow escape valves");
    });

    test("'Outside these four cases the rule is absolute'", () => {
      expect(hatch).toContain("Outside these four cases the rule is absolute");
    });

    test("'Exceptions 1–4' line present", () => {
      expect(hatch).toContain("Exceptions 1–4");
    });

    test("includes Exception 4 — Mock-structure handoff", () => {
      expect(hatch).toContain("### Exception 4 — Mock-structure handoff");
    });

    test("Exception 4 case (a): wrong mocks", () => {
      expect(hatch).toContain("mocks reference primitives the new code bypasses");
    });

    test("Exception 4 case (b): required test-infrastructure", () => {
      expect(hatch).toContain("Required test-infrastructure does not yet exist and must be introduced");
    });

    test("case (b) hermetic language", () => {
      expect(hatch).toContain("hermetic/fixture-backed test surface");
    });

    test("includes all four exception headings", () => {
      expect(hatch).toContain("### Exception 1 — Lint-only edit");
      expect(hatch).toContain("### Exception 2 — PRD-contract mismatch");
      expect(hatch).toContain("### Exception 3 — Unrelated sibling spillover");
      expect(hatch).toContain("### Exception 4 — Mock-structure handoff");
    });

    test("snapshot: full TDD escape hatch", () => {
      expect(hatch).toMatchSnapshot();
    });
  });

  describe("non-TDD path (includeMockHandoff: false)", () => {
    const hatch = buildEscapeHatch({ includeMockHandoff: false });

    test("says 'three narrow escape valves'", () => {
      expect(hatch).toContain("three narrow escape valves");
    });

    test("'Outside these three cases the rule is absolute'", () => {
      expect(hatch).toContain("Outside these three cases the rule is absolute");
    });

    test("'Exceptions 1–3' line present", () => {
      expect(hatch).toContain("Exceptions 1–3");
    });

    test("excludes Exception 4", () => {
      expect(hatch).not.toContain("### Exception 4 — Mock-structure handoff");
      expect(hatch).not.toContain("mock_structure");
    });

    test("includes three exception headings only", () => {
      expect(hatch).toContain("### Exception 1 — Lint-only edit");
      expect(hatch).toContain("### Exception 2 — PRD-contract mismatch");
      expect(hatch).toContain("### Exception 3 — Unrelated sibling spillover");
    });

    test("snapshot: full non-TDD escape hatch", () => {
      expect(hatch).toMatchSnapshot();
    });
  });
});

// ─── exceptionCountWord ───────────────────────────────────────────────────────

describe("exceptionCountWord", () => {
  test("three-session-tdd → 'four'", () => {
    expect(exceptionCountWord(TDD_STORY)).toBe("four");
  });

  test("three-session-tdd-lite → 'four'", () => {
    expect(exceptionCountWord(TDD_LITE_STORY)).toBe("four");
  });

  test("no-test → 'three'", () => {
    expect(exceptionCountWord(NO_TEST_STORY)).toBe("three");
  });

  test("no routing → 'three'", () => {
    const story = makeStory({ id: "US-X", routing: undefined });
    expect(exceptionCountWord(story)).toBe("three");
  });
});

// ─── Integration: prompt strings embed correct count ─────────────────────────

const makeCheck = (check: ReviewCheckResult["check"] = "lint"): ReviewCheckResult => ({
  check,
  success: false,
  command: `${check}`,
  exitCode: 1,
  output: `${check} output`,
  durationMs: 10,
});

describe("RectifierPromptBuilder.reviewRectification — story-aware escape hatch", () => {
  test("TDD story: escape hatch has 'four narrow escape valves' and Exceptions 1–4", () => {
    const result = RectifierPromptBuilder.reviewRectification([makeCheck("lint")], TDD_STORY);
    expect(result).toContain("four narrow escape valves");
    expect(result).toContain("Exceptions 1–4");
    expect(result).toContain("### Exception 4 — Mock-structure handoff");
  });

  test("non-TDD story: escape hatch has 'three narrow escape valves', no Exception 4", () => {
    const result = RectifierPromptBuilder.reviewRectification([makeCheck("lint")], NO_TEST_STORY);
    expect(result).toContain("three narrow escape valves");
    expect(result).toContain("Exceptions 1–3");
    expect(result).not.toContain("### Exception 4 — Mock-structure handoff");
  });

  test("TDD story: inline text says 'three' for mechanical checks (mechanicalRectification)", () => {
    // mechanicalRectification uses exceptionCountWord — TDD story should say "four" inline
    const result = RectifierPromptBuilder.reviewRectification([makeCheck("typecheck")], TDD_STORY);
    expect(result).toContain("four narrow exceptions appended below");
  });

  test("non-TDD story: inline text says 'three' for mechanical checks", () => {
    const result = RectifierPromptBuilder.reviewRectification([makeCheck("typecheck")], NO_TEST_STORY);
    expect(result).toContain("three narrow exceptions appended below");
  });
});

describe("RectifierPromptBuilder.firstAttemptDelta — story-aware escape hatch", () => {
  test("TDD story: says 'four' and includes Exception 4", () => {
    const result = RectifierPromptBuilder.firstAttemptDelta([makeCheck()], 3, undefined, TDD_STORY);
    expect(result).toContain("four narrow exceptions appended below");
    expect(result).toContain("four narrow escape valves");
    expect(result).toContain("### Exception 4 — Mock-structure handoff");
  });

  test("non-TDD story: says 'three', no Exception 4", () => {
    const result = RectifierPromptBuilder.firstAttemptDelta([makeCheck()], 3, undefined, NO_TEST_STORY);
    expect(result).toContain("three narrow exceptions appended below");
    expect(result).toContain("three narrow escape valves");
    expect(result).not.toContain("### Exception 4 — Mock-structure handoff");
  });

  test("no story (backward compat): falls back to three-exception safe-default hatch", () => {
    const result = RectifierPromptBuilder.firstAttemptDelta([makeCheck()], 3);
    // Backward compat: no story → "three" in both inline text and the hatch (safe default)
    expect(result).toContain("three narrow exceptions appended below");
    expect(result).toContain("three narrow escape valves");
    expect(result).not.toContain("### Exception 4 — Mock-structure handoff");
  });
});
