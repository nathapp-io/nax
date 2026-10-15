import { describe, expect, test } from "bun:test";
import {
  buildWorkflowStoryReviewPrompt,
  WORKFLOW_ENUMERATION_INSTRUCTION,
  WORKFLOW_QUALITY_CHECKLIST,
} from "@/prompts";

/** The checklist text, reproduced verbatim from SPEC-workflow-review-depth § Approach 1. */
const CHECKLIST = `## Code-quality checklist
Judge the changed code against each class. Report only what you can quote from a file.
- Concurrency and atomicity: a check and the write it guards in separate statements or transactions; two writers racing on one row, slot or counter; shared mutable state without synchronisation.
- Data-store semantics: the collation or case-sensitivity of identity and unique columns; uniqueness enforced only in code, not by the store; transaction boundaries; column types and widths against the values written.
- Production wiring: an in-memory, fake or test stand-in on a production path where the project provides a shared implementation (an id or sequence generator, cache, lock, queue, storage).
- Test isolation: a test that depends on state another test created; ordering dependence; shared mutable fixtures; globals, environment or files not restored.
- Input safety: untrusted keys used for object lookup (inherited keys such as __proto__ or constructor); unbounded lengths or sizes reaching storage; unvalidated input reaching a query, path or command.
- Performance: a database or network call per item inside a loop on a batch path; serial awaits that could be one batched call.
- Error handling: a swallowed failure; a result or exit code never checked; a default substituted on error so the caller cannot tell empty from broken.
- Reachability: a list with no way past its first page; a state a user or caller cannot reach or leave.`;

const storyReview = buildWorkflowStoryReviewPrompt({
  briefPath: "b.md",
  reportPath: "r.md",
  packagePath: "p.diff",
  concerns: [],
});

describe("WORKFLOW_QUALITY_CHECKLIST", () => {
  test("is the checklist text verbatim (AC-1)", () => {
    expect(WORKFLOW_QUALITY_CHECKLIST).toBe(CHECKLIST);
  });
});

describe("WORKFLOW_ENUMERATION_INSTRUCTION", () => {
  test("is the enumeration instruction verbatim (AC-2)", () => {
    expect(WORKFLOW_ENUMERATION_INSTRUCTION).toBe(
      "Before you give the quality verdict, walk every function or method the diff adds or changes and judge it against the checklist.",
    );
  });
});

describe("the story review prompt embeds the shared checklist", () => {
  test("includes the checklist (AC-3)", () => {
    expect(storyReview).toContain(WORKFLOW_QUALITY_CHECKLIST);
  });

  test("includes the enumeration instruction (AC-4)", () => {
    expect(storyReview).toContain(WORKFLOW_ENUMERATION_INSTRUCTION);
  });

  test("keeps the observed-excerpt rule for critical and important findings (AC-5)", () => {
    expect(storyReview).toContain("verbatim 1-3 line excerpt");
  });
});
