/**
 * Tests for rectifier-builder-helpers — buildEscapeHatch + exceptionCountWord
 *
 * Verifies that the escape-hatch section dynamically matches the story's TDD strategy:
 * - TDD path: 4 exceptions, "four" in count text, includes Exception 4 with both cases
 * - Non-TDD path: 3 exceptions, "three" in count text, excludes Exception 4
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "../../../helpers";
import {
  buildEscapeHatch,
  exceptionCountWord,
  implementerOwnsTests,
  testEditHeadline,
  escapeHatchFor,
} from "../../../../src/prompts/builders/rectifier-builder-helpers";
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

const TDD_SIMPLE_STORY = makeStory({
  id: "US-SIMPLE",
  title: "Single-session story",
  description: "A story where one agent writes tests AND implementation.",
  acceptanceCriteria: ["AC1"],
  routing: { testStrategy: "tdd-simple", complexity: "medium", reasoning: "test" },
});

const TEST_AFTER_STORY = makeStory({
  id: "US-AFTER",
  title: "Test-after story",
  description: "A story where the implementer writes tests after implementation.",
  acceptanceCriteria: ["AC1"],
  routing: { testStrategy: "test-after", complexity: "simple", reasoning: "test" },
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

// ─── Single-session implementer test-edit policy ──────────────────────────────
//
// In single-session strategies (tdd-simple, test-after) ONE agent writes both the
// tests and the implementation. No separate test-writer owns the test contract, so
// the implementer MAY edit test files during rectification (permit-with-guard) —
// unlike three-session TDD where the prohibition is absolute. See US-003 in the
// 2026-06-01 run: a single-session implementer punted with UNRESOLVED because the
// rectification prompt forbade the test edit needed to resolve an AC contradiction.

describe("implementerOwnsTests", () => {
  test("tdd-simple → true (single-session, implementer authors tests)", () => {
    expect(implementerOwnsTests(TDD_SIMPLE_STORY)).toBe(true);
  });

  test("test-after → true (single-session, implementer authors tests)", () => {
    expect(implementerOwnsTests(TEST_AFTER_STORY)).toBe(true);
  });

  test("three-session-tdd → false (separate test-writer owns tests)", () => {
    expect(implementerOwnsTests(TDD_STORY)).toBe(false);
  });

  test("three-session-tdd-lite → false (separate test-writer owns tests)", () => {
    expect(implementerOwnsTests(TDD_LITE_STORY)).toBe(false);
  });

  test("no-test → false (no tests to own)", () => {
    expect(implementerOwnsTests(NO_TEST_STORY)).toBe(false);
  });

  test("no routing → false (safe default: keep prohibition)", () => {
    expect(implementerOwnsTests(makeStory({ id: "US-X", routing: undefined }))).toBe(false);
  });
});

describe("testEditHeadline", () => {
  const PROHIBITION = "Do NOT change test files or test behavior — see the three narrow exceptions appended below.";

  test("single-session story → permit headline (MAY edit), not the prohibition", () => {
    const headline = testEditHeadline(TDD_SIMPLE_STORY, PROHIBITION);
    expect(headline).toContain("MAY edit test files");
    expect(headline).not.toContain("Do NOT change test files");
  });

  test("test-after story → permit headline", () => {
    expect(testEditHeadline(TEST_AFTER_STORY, PROHIBITION)).toContain("MAY edit test files");
  });

  test("three-session story → returns the prohibition text verbatim (unchanged)", () => {
    expect(testEditHeadline(TDD_STORY, PROHIBITION)).toBe(PROHIBITION);
  });

  test("no-test story → returns the prohibition text verbatim (unchanged)", () => {
    expect(testEditHeadline(NO_TEST_STORY, PROHIBITION)).toBe(PROHIBITION);
  });
});

describe("escapeHatchFor — single-session permit block", () => {
  test("tdd-simple: emits permit-with-guard guidance, not the absolute prohibition", () => {
    const hatch = escapeHatchFor(TDD_SIMPLE_STORY);
    expect(hatch).toContain("Test-edit guidance (single-session implementer)");
    expect(hatch).toContain("MAY edit test files");
    expect(hatch).toContain("NEVER weaken, delete, loosen");
    // The absolute-prohibition framing and Exception 4 handoff must NOT appear.
    expect(hatch).not.toContain("the rule is absolute");
    expect(hatch).not.toContain("### Exception 4 — Mock-structure handoff");
  });

  test("test-after: emits permit-with-guard guidance", () => {
    expect(escapeHatchFor(TEST_AFTER_STORY)).toContain("Test-edit guidance (single-session implementer)");
  });

  test("three-session-tdd: unchanged — four-exception prohibition hatch", () => {
    const hatch = escapeHatchFor(TDD_STORY);
    expect(hatch).toContain("four narrow escape valves");
    expect(hatch).toContain("the rule is absolute");
    expect(hatch).toContain("### Exception 4 — Mock-structure handoff");
    expect(hatch).not.toContain("Test-edit guidance (single-session implementer)");
  });

  test("no-test: unchanged — three-exception prohibition hatch", () => {
    const hatch = escapeHatchFor(NO_TEST_STORY);
    expect(hatch).toContain("three narrow escape valves");
    expect(hatch).not.toContain("Test-edit guidance (single-session implementer)");
  });
});

describe("rectification prompts — single-session permits test edits (US-003 regression)", () => {
  test("reviewRectification(semantic) for tdd-simple: permits edits, drops the prohibition", () => {
    const result = RectifierPromptBuilder.reviewRectification([makeCheck("semantic")], TDD_SIMPLE_STORY);
    expect(result).toContain("MAY edit test files");
    expect(result).toContain("Test-edit guidance (single-session implementer)");
    expect(result).not.toContain("Do NOT change test files or test behavior");
    expect(result).not.toContain("the rule is absolute");
  });

  test("reviewRectification(semantic) for three-session: still forbids test edits", () => {
    const result = RectifierPromptBuilder.reviewRectification([makeCheck("semantic")], TDD_STORY);
    expect(result).toContain("Do NOT change test files or test behavior");
    expect(result).toContain("the rule is absolute");
    expect(result).not.toContain("MAY edit test files");
  });

  test("firstAttemptDelta for tdd-simple: permits edits", () => {
    const result = RectifierPromptBuilder.firstAttemptDelta([makeCheck("semantic")], 3, undefined, TDD_SIMPLE_STORY);
    expect(result).toContain("MAY edit test files");
    expect(result).not.toContain("Do NOT change test files or test behavior");
  });

  test("regressionFailure for tdd-simple: permits edits", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: TDD_SIMPLE_STORY,
      failures: [],
      testCommand: "bun test",
    });
    expect(result).toContain("MAY edit test files");
    expect(result).not.toContain("Do NOT modify test files");
  });

  test("mechanicalRectification(typecheck) for tdd-simple: permits edits", () => {
    const result = RectifierPromptBuilder.reviewRectification([makeCheck("typecheck")], TDD_SIMPLE_STORY);
    expect(result).toContain("MAY edit test files");
    expect(result).not.toContain("Do NOT change test files or test behavior except via those exceptions");
  });

  test("escalated for tdd-simple: permits edits; three-session still forbids", () => {
    const permitted = RectifierPromptBuilder.escalated([], TDD_SIMPLE_STORY, 2, "fast", "powerful");
    expect(permitted).toContain("MAY edit test files");
    expect(permitted).not.toContain("Do NOT modify test files");

    const forbidden = RectifierPromptBuilder.escalated([], TDD_STORY, 2, "fast", "powerful");
    expect(forbidden).toContain("Do NOT modify test files");
    expect(forbidden).not.toContain("MAY edit test files");
  });

  test("dialogueAwareRectification for tdd-simple: permits edits; three-session still forbids", () => {
    const opts = { findingReasoning: new Map<string, string>(), history: [] };
    const permitted = RectifierPromptBuilder.dialogueAwareRectification([makeCheck("semantic")], TDD_SIMPLE_STORY, opts);
    expect(permitted).toContain("MAY edit test files");
    expect(permitted).not.toContain("Do NOT change test files or test behavior");

    const forbidden = RectifierPromptBuilder.dialogueAwareRectification([makeCheck("semantic")], TDD_STORY, opts);
    expect(forbidden).toContain("Do NOT change test files or test behavior");
    expect(forbidden).not.toContain("MAY edit test files");
  });
});
