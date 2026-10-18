/**
 * US-007 — the project-context override section of a workflow brief.
 *
 * `buildWorkflowBrief` is the whole brief for one story; the section the run's
 * `context.projectContext.file` produces sits after "## Feature context" and
 * before "## Project rules" (the constitution): the feature's context first, the
 * run's organisation/job context next, the repository's own rules last.
 *
 * Deliberately not the file's `section()` helper: that trims its body, and this
 * body is the operator's file verbatim (SPEC-lazy-rules-delivery §
 * Project-context override section). What an implementer is told must be what
 * the operator wrote.
 *
 * The AC id is the test-name prefix.
 */

import { describe, expect, test } from "bun:test";
import { buildWorkflowBrief, type WorkflowBriefInput } from "@/prompts";

const HEADING = "## Project context (run override)";

const briefInput: WorkflowBriefInput = {
  storyId: "US-007",
  title: "Project-context override delivery",
  description: "Deliver the run's project-context file.",
  acceptanceCriteria: ["deliver it"],
  contextFiles: ["src/a.ts"],
  expectedFiles: ["src/a.ts"],
  specExcerpts: [],
  rulings: [],
  redBaseDependencies: [],
  reportPath: "/out/US-007/report.md",
};

describe("buildWorkflowBrief — the project-context override section (AC-7)", () => {
  test("AC-7: the section carries the override body and follows ## Feature context", () => {
    const text = buildWorkflowBrief({
      ...briefInput,
      featureContext: "FEATURE",
      projectContextOverride: "X-OVERRIDE",
    });

    expect(text).toContain(HEADING);
    expect(text).toContain("X-OVERRIDE");
    const heading = text.indexOf(HEADING);
    const feature = text.indexOf("## Feature context");
    expect(feature).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(feature);
    // The heading is immediately followed by the body, with a blank line between.
    expect(text.slice(heading, heading + HEADING.length + "X-OVERRIDE".length + 2)).toBe(`${HEADING}\n\nX-OVERRIDE`);
  });

  test("AC-7: the section precedes ## Project rules when a constitution is present", () => {
    const text = buildWorkflowBrief({
      ...briefInput,
      featureContext: "FEATURE",
      projectContextOverride: "X-OVERRIDE",
      constitution: "EXISTING-CONSTITUTION",
    });

    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf("## Project rules"));
    expect(text.indexOf("## Feature context")).toBeLessThan(text.indexOf(HEADING));
    expect(text).toContain("EXISTING-CONSTITUTION");
  });

  test("the body is verbatim: leading, trailing and internal whitespace survive", () => {
    const body = "\n  # Org context\n\n  Indent me.\n\n";
    const text = buildWorkflowBrief({
      ...briefInput,
      featureContext: "FEATURE",
      projectContextOverride: body,
    });

    expect(text).toContain(`${HEADING}\n\n${body}\n`);
  });

  test("the override is rendered even when the story has no feature context", () => {
    const text = buildWorkflowBrief({ ...briefInput, projectContextOverride: "X-OVERRIDE" });

    expect(text).toContain(HEADING);
    expect(text).toContain("X-OVERRIDE");
    expect(text).not.toContain("## Feature context");
  });

  test("no override emits no heading, and the brief is otherwise unchanged", () => {
    const withOut = buildWorkflowBrief({ ...briefInput, featureContext: "FEATURE" });

    expect(withOut).not.toContain(HEADING);
    expect(withOut).toContain("## Feature context");
    expect(withOut).toContain("# Brief: US-007");
  });

  test("a configured but empty override still carries its heading", () => {
    const withEmpty = buildWorkflowBrief({ ...briefInput, featureContext: "FEATURE", projectContextOverride: "" });

    // "configured" is the presence of a file, not the size of its content: the
    // operator asked for the section, and an empty file renders as one.
    expect(withEmpty).toContain(HEADING);
    expect(withEmpty).toContain(`${HEADING}\n\n\n`);
  });

  test("a whitespace-only override is a section, with its content verbatim", () => {
    const body = "   \n\n";

    expect(buildWorkflowBrief({ ...briefInput, projectContextOverride: body })).toContain(`${HEADING}\n\n${body}\n`);
  });
});
