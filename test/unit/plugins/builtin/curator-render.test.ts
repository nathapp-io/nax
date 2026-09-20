/**
 * Curator Render Tests
 *
 * Tests for markdown rendering of proposals.
 */

import { describe, expect, test } from "bun:test";
import type { Proposal } from "@/plugins/builtin/curator/heuristics";
import { renderProposals } from "@/plugins/builtin/curator/render";

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

describe("renderProposals — evidence survives `nax curator commit` (#1422)", () => {
  test("multi-line evidence is flattened so the parser keeps the samples", async () => {
    const { _testing } = await import("@/commands/curator");
    const markdown = renderProposals(
      [
        {
          id: "H1",
          severity: "MED",
          target: { canonicalFile: ".nax/rules/curator-suggestions.md", action: "add" },
          description: "Recurring across 3 features — test-gap: placeholder assertion",
          evidence:
            "Seen in 3 features: a, b, c (sites: a/US-001).\n  Examples: expect(true).toBe(true) | source-inspection test",
          sourceKinds: ["review-finding"],
          storyIds: ["a/US-001"],
        },
      ],
      "run-1",
      3,
    );

    // The rendered evidence must occupy exactly one line...
    const evidenceLines = markdown.split("\n").filter((l) => l.includes("_Evidence:"));
    expect(evidenceLines).toHaveLength(1);
    expect(evidenceLines[0]).toContain("Examples:");

    // ...and survive a real accept round-trip.
    const checked = markdown.replace("- [ ]", "- [x]");
    const parsed = _testing.parseCheckedProposals(checked);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].evidence).toContain("expect(true).toBe(true)");
  });
});

/**
 * Heuristic-window provenance — header attributes the heuristic window the
 * proposals derive from (US-003). ACs 1, 2, 3, 7 and 9 are exercised against
 * `renderProposals` directly because that is the single seam between the
 * heuristic pipeline and the markdown the operator reads.
 */
describe("renderProposals — heuristic-window provenance (US-003)", () => {
  const provenanceBaseProposal: Proposal = {
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

  test("AC1: header states both the window run count and the window observation count when provenance is given", () => {
    const markdown = renderProposals([provenanceBaseProposal], "run-1294", 1294, {
      runCount: 20,
      observationCount: 4000,
    });

    // The window run count and the window observation count must both appear
    // in the header — that is the whole point of carrying provenance here.
    expect(markdown).toContain("20");
    expect(markdown).toContain("4000");
  });

  test("AC1 (boundary): zero-window provenance still surfaces the zero in the header", () => {
    const markdown = renderProposals([provenanceBaseProposal], "run-x", 0, {
      runCount: 0,
      observationCount: 0,
    });
    expect(markdown).toContain("0");
  });

  test("AC2: header separately states the run's own observation count of 1294", () => {
    const markdown = renderProposals([provenanceBaseProposal], "run-1294", 1294, {
      runCount: 20,
      observationCount: 4000,
    });

    // The run's own 1294 observations is a distinct fact from the 4000 window
    // observations — the header must keep both so neither is misattributed.
    expect(markdown).toContain("1294");
    expect(markdown).toContain("4000");
  });

  test("AC2 (boundary): identical window and run counts both still surface", () => {
    // When window == run == 5, the header still distinguishes "5 in the window"
    // from "5 in this run" — the wording must not collapse two counts into one.
    const markdown = renderProposals([provenanceBaseProposal], "run-x", 5, {
      runCount: 1,
      observationCount: 5,
    });
    expect(markdown.match(/5/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("AC3: provenance with runCount=1 produces a header that says 'one run', not '20 runs'", () => {
    const oneRunHeader = renderProposals([provenanceBaseProposal], "run-x", 7, {
      runCount: 1,
      observationCount: 7,
    });
    const twentyRunHeader = renderProposals([provenanceBaseProposal], "run-x", 7, {
      runCount: 20,
      observationCount: 140,
    });

    // The single-run provenance must NOT look like the multi-run header.
    // The empty-window fallback that would otherwise be misread as "20 runs"
    // (#1929 of course).
    expect(oneRunHeader).not.toBe(twentyRunHeader);
    // And the one-run header should describe the window as a single run.
    expect(oneRunHeader).toMatch(/1\s+run/);
  });

  test("AC3 (boundary): zero-run provenance produces a header that does NOT say 'one run'", () => {
    const markdown = renderProposals([provenanceBaseProposal], "run-x", 7, {
      runCount: 0,
      observationCount: 0,
    });
    expect(markdown).not.toMatch(/\b1\s+run\b/);
  });

  test("AC7: 3-arg form keeps working — header states one run and a window observation count equal to the run's own count", () => {
    // The single-run dryrun default: omitting provenance must default to a
    // window of { runCount: 1, observationCount }, which makes the header
    // carry the run's own observation count both as the window observation
    // count and as the run observation count. Both must surface — a header
    // that reads "0 window observations · 100 run observations" would NOT
    // satisfy the AC's invariant that the window count equals the run's own.
    const markdown = renderProposals([provenanceBaseProposal], "run-x", 100);

    expect(markdown).toMatch(/1\s+run/);
    // Match the window observation count token directly — a header that
    // lists the window count as 0 but the run count as 100 would pass a
    // naive `toContain("100")` check, but does not satisfy AC7. Capturing
    // the value rather than counting occurrences is robust against
    // unrelated "100" substrings.
    const windowMatch = markdown.match(/(\d+)\s+window observation/);
    expect(windowMatch?.[1]).toBe("100");
    const runMatch = markdown.match(/(\d+)\s+run observation/);
    expect(runMatch?.[1]).toBe("100");
  });

  test("AC7 (boundary): 3-arg form with zero observations still says one run and zero window observations", () => {
    const markdown = renderProposals([], "run-x", 0);

    expect(markdown).toMatch(/1\s+run/);
    expect(markdown).toContain("0");
  });

  test("AC9: empty-proposal line attributes its observation count to the heuristic window, not to this run", () => {
    // The pre-story wording "No heuristics fired for this run" misattributed the
    // count — the empty line must NOT say "for this run" and must mention the
    // window count instead.
    const markdown = renderProposals([], "run-x", 100, { runCount: 20, observationCount: 4000 });

    expect(markdown).not.toMatch(/for this run/i);
    // The window observation count (4000) appears in the empty-proposals line.
    expect(markdown).toContain("4000");
  });

  test("AC9 (boundary): empty-proposal line in 3-arg form omits the 'for this run' wording", () => {
    const markdown = renderProposals([], "run-x", 0);

    expect(markdown).not.toMatch(/for this run/i);
  });
});
