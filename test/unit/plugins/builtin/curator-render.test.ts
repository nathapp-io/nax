/**
 * Curator Render Tests
 *
 * Tests for markdown rendering of proposals.
 */

import { describe, expect, test } from "bun:test";
import { renderProposals } from "../../../../src/plugins/builtin/curator/render";
import type { Proposal } from "../../../../src/plugins/builtin/curator/heuristics";

describe("renderProposals", () => {
  const baseProposal: Proposal = {
    id: "H1",
    severity: "MED",
    target: {
      canonicalFile: ".nax/rules/curator-suggestions.md",
      action: "add",
    },
    description: "Test description",
    evidence: "Evidence line 1",
    sourceKinds: ["review-finding"],
    storyIds: ["story-1", "story-2"],
  };

  test("produces markdown with timestamp", () => {
    const markdown = renderProposals([baseProposal], "run-1", 5);

    expect(markdown).toContain("generated at");
    expect(markdown.match(/\d{4}-\d{2}-\d{2}/)).toBeTruthy();
  });

  test("includes observation count in output", () => {
    const markdown = renderProposals([baseProposal], "run-1", 42);

    expect(markdown).toContain("42");
  });

  test("groups proposals by target action", () => {
    const proposals: Proposal[] = [
      {
        ...baseProposal,
        id: "H1",
        target: { canonicalFile: "file1.md", action: "add" },
      },
      {
        ...baseProposal,
        id: "H2",
        target: { canonicalFile: "file2.md", action: "drop" },
      },
    ];

    const markdown = renderProposals(proposals, "run-1", 10);

    // Should have separate sections for add and drop
    expect(markdown).toContain("add");
    expect(markdown).toContain("drop");
  });

  test("groups proposals by canonical file within action", () => {
    const proposals: Proposal[] = [
      {
        ...baseProposal,
        id: "H1",
        target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "add" },
      },
      {
        ...baseProposal,
        id: "H2",
        target: { canonicalFile: ".nax/features/feat-1/context.md", action: "add" },
      },
    ];

    const markdown = renderProposals(proposals, "run-1", 10);

    expect(markdown).toContain(".nax/rules/curator-suggestions.md");
    expect(markdown).toContain(".nax/features/feat-1/context.md");
  });

  test("includes severity in brackets on proposal lines", () => {
    const markdown = renderProposals([baseProposal], "run-1", 5);

    expect(markdown).toContain("[MED]");
  });

  test("includes heuristic ID on proposal lines", () => {
    const markdown = renderProposals([baseProposal], "run-1", 5);

    expect(markdown).toContain("H1");
  });

  test("includes story evidence in proposal lines", () => {
    const markdown = renderProposals([baseProposal], "run-1", 5);

    expect(markdown).toContain("story-1");
    expect(markdown).toContain("story-2");
  });

  test("produces useful markdown with zero proposals", () => {
    const markdown = renderProposals([], "run-1", 10);

    expect(markdown).toMatch(/\S/);
    expect(markdown).toContain("observation");
    expect(markdown).toContain("10");
  });

  test("includes checkbox sections for action items", () => {
    const markdown = renderProposals([baseProposal], "run-1", 5);

    // Should have checkboxes for user action
    expect(markdown).toContain("- [ ]");
  });

  test("renders all proposal fields", () => {
    const proposal: Proposal = {
      id: "H3",
      severity: "HIGH",
      target: {
        canonicalFile: ".nax/features/feat-1/context.md",
        action: "add",
      },
      description: "High priority issue detected",
      evidence: "5 consecutive failures in story-1",
      sourceKinds: ["rectify-cycle"],
      storyIds: ["story-1"],
    };

    const markdown = renderProposals([proposal], "run-2", 25);

    expect(markdown).toContain("H3");
    expect(markdown).toContain("HIGH");
    expect(markdown).toContain("High priority issue detected");
    expect(markdown).toContain("feat-1");
  });

  test("handles multiple stories in evidence", () => {
    const proposal: Proposal = {
      ...baseProposal,
      storyIds: ["story-a", "story-b", "story-c"],
    };

    const markdown = renderProposals([proposal], "run-1", 10);

    expect(markdown).toContain("story-a");
    expect(markdown).toContain("story-b");
    expect(markdown).toContain("story-c");
  });

  test("distinguishes severity levels visually", () => {
    const proposals: Proposal[] = [
      { ...baseProposal, id: "H1", severity: "LOW" },
      { ...baseProposal, id: "H2", severity: "MED" },
      { ...baseProposal, id: "H3", severity: "HIGH" },
    ];

    const markdown = renderProposals(proposals, "run-1", 10);

    expect(markdown).toContain("[LOW]");
    expect(markdown).toContain("[MED]");
    expect(markdown).toContain("[HIGH]");
  });

  test("renders different action types distinctly", () => {
    const proposals: Proposal[] = [
      {
        ...baseProposal,
        target: { canonicalFile: "file.md", action: "add" },
      },
      {
        ...baseProposal,
        target: { canonicalFile: "file.md", action: "drop" },
      },
      {
        ...baseProposal,
        target: { canonicalFile: "file.md", action: "advisory" },
      },
    ];

    const markdown = renderProposals(proposals, "run-1", 10);

    // All actions should be present
    expect(markdown).toContain("add");
    expect(markdown).toContain("drop");
    expect(markdown).toContain("advisory");
  });

  test("is valid markdown with proper formatting", () => {
    const markdown = renderProposals([baseProposal], "run-1", 5);

    // Should have markdown structure
    expect(markdown).toContain("#");
    expect(markdown).toContain("- [ ]");
    expect(markdown).toContain("\n");
  });

  test("includes run ID in output", () => {
    const markdown = renderProposals([baseProposal], "run-abc-123", 5);

    expect(markdown).toContain("run-abc-123");
  });

  test("renders with high observation count", () => {
    const markdown = renderProposals([baseProposal], "run-1", 1000000);

    expect(markdown).toContain("1000000");
  });

  test("handles empty evidence gracefully", () => {
    const proposal: Proposal = {
      ...baseProposal,
      evidence: "",
    };

    const markdown = renderProposals([proposal], "run-1", 5);

    expect(markdown).toMatch(/\S/);
  });
});
