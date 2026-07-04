/**
 * renderReport — Failure-focused replay report renderer (US-003)
 *
 * AC-1:  @/replay exposes `renderReport`.
 * AC-2:  Default render shows passed story id on a summary line and failed
 *        story's inferred phase names on their own lines.
 * AC-3:  Default render shows no per-phase lines for a passed story but does
 *        include the failed story's phases.
 * AC-4:  `{ all: true }` includes passed story's phase names.
 * AC-5:  `{ story: "US-002" }` shows only that story's block.
 * AC-6:  Failed terminal phase line carries a "root cause" marker.
 * AC-7:  Header contains runId, feature, status, story count, and total cost.
 * AC-8:  Output includes the best-effort "reconstructed from logs" notice.
 * AC-9:  status="crashed" + story.cost===undefined renders a placeholder for
 *        missing cost without throwing, and the header contains "CRASHED".
 */

import { describe, expect, test } from "bun:test";
import { renderReport, type RenderOptions } from "@/replay";
import type { RunTimeline, StoryTimeline } from "@/replay";

function buildStory(overrides: Partial<StoryTimeline> & { storyId: string }): StoryTimeline {
  const { storyId, ...rest } = overrides;
  return {
    storyId,
    status: "passed",
    finalTier: "balanced",
    cost: 0.1,
    attempts: 1,
    phases: [],
    escalations: [],
    ...rest,
  };
}

function buildTimeline(overrides: Partial<RunTimeline> = {}): RunTimeline {
  return {
    runId: "run-001",
    feature: "feat-auth",
    status: "completed",
    inferred: true,
    stories: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1: renderReport is exported from @/replay (via @/replay/report)
// ---------------------------------------------------------------------------

describe("renderReport — module export", () => {
  test("AC1: renderReport is an exported function from @/replay/report", () => {
    expect(typeof renderReport).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-2: default render — passed story id on summary line + failed story phases
// ---------------------------------------------------------------------------

describe("renderReport — AC2: default render of passed+failed timeline", () => {
  test("AC2: default render contains the passed story id on a summary line", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({ storyId: "US-001", status: "passed", cost: 0.1 }),
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [
            { name: "test-writer", status: "pass" },
            { name: "implementer", status: "pass" },
            { name: "full-suite-gate", status: "fail" },
          ],
          rootCausePhaseIndex: 2,
        }),
      ],
    });

    const out = renderReport(tl);

    expect(out).toContain("US-001");
  });

  test("AC2: default render contains each inferred failed-story phase name", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({ storyId: "US-001", status: "passed", cost: 0.1 }),
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [
            { name: "test-writer", status: "pass" },
            { name: "implementer", status: "pass" },
            { name: "full-suite-gate", status: "fail" },
          ],
          rootCausePhaseIndex: 2,
        }),
      ],
    });

    const out = renderReport(tl);

    expect(out).toContain("test-writer");
    expect(out).toContain("implementer");
    expect(out).toContain("full-suite-gate");
  });
});

// ---------------------------------------------------------------------------
// AC-3: default render — no per-phase lines for passed story
// ---------------------------------------------------------------------------

describe("renderReport — AC3: default render skips passed phases", () => {
  test("AC3: default render does not show per-phase lines for a passed story", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({
          storyId: "US-001",
          status: "passed",
          cost: 0.1,
          phases: [
            { name: "passed-only-alpha", status: "pass" },
            { name: "passed-only-bravo", status: "pass" },
            { name: "passed-only-charlie", status: "pass" },
          ],
        }),
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [
            { name: "failed-only-delta", status: "pass" },
            { name: "failed-only-echo", status: "fail" },
          ],
          rootCausePhaseIndex: 1,
        }),
      ],
    });

    const out = renderReport(tl);

    // The passed story's phase names must not appear anywhere in the output
    // when default options are used. Use unique phase names so the assertion
    // cannot match the failed story's phases.
    expect(out).not.toContain("passed-only-alpha");
    expect(out).not.toContain("passed-only-bravo");
    expect(out).not.toContain("passed-only-charlie");
    // Sanity: the failed story's phases ARE present.
    expect(out).toContain("failed-only-delta");
    expect(out).toContain("failed-only-echo");
  });

  test("AC3: default render includes the failed story's phases", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({
          storyId: "US-001",
          status: "passed",
          cost: 0.1,
          phases: [{ name: "test-writer", status: "pass" }],
        }),
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [
            { name: "test-writer", status: "pass" },
            { name: "implementer", status: "fail" },
          ],
          rootCausePhaseIndex: 1,
        }),
      ],
    });

    const out = renderReport(tl);
    const failedBlock = extractStoryBlock(out, "US-002");

    expect(failedBlock).toContain("test-writer");
    expect(failedBlock).toContain("implementer");
  });
});

// ---------------------------------------------------------------------------
// AC-4: --all option — show passed story phases too
// ---------------------------------------------------------------------------

describe("renderReport — AC4: all option shows passed phases", () => {
  test("AC4: with `{ all: true }`, output contains a passed story's phase names", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({
          storyId: "US-001",
          status: "passed",
          cost: 0.1,
          phases: [
            { name: "test-writer", status: "pass" },
            { name: "implementer", status: "pass" },
            { name: "verifier", status: "pass" },
          ],
        }),
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [{ name: "implementer", status: "fail" }],
          rootCausePhaseIndex: 0,
        }),
      ],
    });

    const opts: RenderOptions = { all: true };
    const out = renderReport(tl, opts);

    expect(out).toContain("test-writer");
    expect(out).toContain("verifier");
  });
});

// ---------------------------------------------------------------------------
// AC-5: --story option — only that story's block
// ---------------------------------------------------------------------------

describe("renderReport — AC5: story filter", () => {
  test("AC5: with `{ story: 'US-002' }`, output contains US-002's block and no other story id", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({
          storyId: "US-001",
          status: "passed",
          cost: 0.1,
          phases: [{ name: "implementer", status: "pass" }],
        }),
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [{ name: "implementer", status: "fail" }],
          rootCausePhaseIndex: 0,
        }),
        buildStory({
          storyId: "US-003",
          status: "passed",
          cost: 0.3,
          phases: [{ name: "implementer", status: "pass" }],
        }),
      ],
    });

    const opts: RenderOptions = { story: "US-002" };
    const out = renderReport(tl, opts);

    expect(out).toContain("US-002");
    expect(out).not.toContain("US-001");
    expect(out).not.toContain("US-003");
  });
});

// ---------------------------------------------------------------------------
// AC-6: root-cause marker on the failed terminal phase line
// ---------------------------------------------------------------------------

describe("renderReport — AC6: root cause marker", () => {
  test("AC6: failed terminal phase line carries a 'root cause' marker", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [
            { name: "test-writer", status: "pass" },
            { name: "implementer", status: "fail" },
          ],
          rootCausePhaseIndex: 1,
        }),
      ],
    });

    const out = renderReport(tl);

    expect(out.toLowerCase()).toContain("root cause");
  });

  test("AC6: root cause marker goes on the TERMINAL failed phase when multiple phases failed (fix-cycle case)", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.2,
          phases: [
            { name: "test-writer", status: "fail" },
            { name: "implementer", status: "pass" },
            { name: "verifier", status: "fail" },
          ],
          // Reconstructor records the FIRST fail; the marker must still
          // land on the terminal (verifier) line per AC-6.
          rootCausePhaseIndex: 0,
        }),
      ],
    });

    const out = renderReport(tl);
    const lines = out.split("\n");
    const verifierLineIdx = lines.findIndex((l) => l.includes("verifier"));
    const testWriterLineIdx = lines.findIndex((l) => l.includes("test-writer"));

    expect(verifierLineIdx).toBeGreaterThan(0);
    expect(testWriterLineIdx).toBeGreaterThan(0);
    expect(lines[verifierLineIdx]!.toLowerCase()).toContain("root cause");
    expect(lines[testWriterLineIdx]!.toLowerCase()).not.toContain("root cause");
  });
});

// ---------------------------------------------------------------------------
// AC-7: header — runId, feature, status, story count, total cost
// ---------------------------------------------------------------------------

describe("renderReport — AC7: header summary", () => {
  test("AC7: header contains runId, feature, run status, story count, and total cost", () => {
    const tl = buildTimeline({
      runId: "run-xyz",
      feature: "feat-billing",
      status: "failed",
      stories: [
        buildStory({ storyId: "US-001", status: "passed", cost: 0.5 }),
        buildStory({
          storyId: "US-002",
          status: "failed",
          cost: 0.25,
          phases: [{ name: "implementer", status: "fail" }],
          rootCausePhaseIndex: 0,
        }),
      ],
    });

    const out = renderReport(tl);

    expect(out).toContain("run-xyz");
    expect(out).toContain("feat-billing");
    expect(out.toLowerCase()).toMatch(/failed/);
    expect(out).toMatch(/stories?:\s*2/i);
    expect(out).toMatch(/0\.7500|cost.*0\.75/i);
  });

  test("AC7 boundary: total cost sums each story's cost", () => {
    const tl = buildTimeline({
      stories: [
        buildStory({ storyId: "US-001", status: "passed", cost: 0.1 }),
        buildStory({ storyId: "US-002", status: "failed", cost: 0.2 }),
      ],
    });

    const out = renderReport(tl);

    expect(out).toMatch(/0\.3000|cost.*0\.3/i);
  });

  test("AC7 boundary: NaN cost is treated as missing and renders a placeholder", () => {
    const tl = buildTimeline({
      runId: "run-nan",
      feature: "feat-nan",
      stories: [
        // NaN passes `typeof === "number"` but is not a real value; the
        // renderer must not render `$NaN`.
        buildStory({ storyId: "US-001", status: "passed", cost: Number.NaN }),
      ],
    });

    const out = renderReport(tl);

    expect(out).not.toContain("NaN");
    expect(out).toMatch(/^Cost:.*(\?|--|unknown|—|n\/a)\s*$/im);
  });
});

// ---------------------------------------------------------------------------
// AC-8: best-effort notice
// ---------------------------------------------------------------------------

describe("renderReport — AC8: best-effort notice", () => {
  test("AC8: output contains a best-effort notice indicating phases were reconstructed from logs", () => {
    const tl = buildTimeline({
      stories: [buildStory({ storyId: "US-001", status: "passed", cost: 0.1 })],
    });

    const out = renderReport(tl);

    expect(out.toLowerCase()).toContain("reconstructed from logs");
  });
});

// ---------------------------------------------------------------------------
// AC-9: crashed run — placeholder for missing cost, header contains CRASHED
// ---------------------------------------------------------------------------

describe("renderReport — AC9: crashed-run rendering", () => {
  test("AC9: crashed run with story.cost undefined renders a placeholder and does not throw", () => {
    const tl = buildTimeline({
      runId: "run-crash",
      feature: "feat-x",
      status: "crashed",
      stories: [
        buildStory({
          storyId: "US-001",
          status: "crashed",
          cost: undefined,
          phases: [{ name: "test-writer", status: "pass" }],
        }),
      ],
    });

    let out: string;
    expect(() => {
      out = renderReport(tl);
    }).not.toThrow();

    expect(out!).toContain("CRASHED");
    // Header cost line must render a placeholder for missing cost
    expect(out!).toMatch(/^Cost:.*(\?|--|unknown|—|n\/a)\s*$/im);
  });

  test("AC9 boundary: crashed run header contains CRASHED even when no stories have cost", () => {
    const tl = buildTimeline({
      runId: "run-crash",
      feature: "feat-x",
      status: "crashed",
      stories: [],
    });

    const out = renderReport(tl);

    expect(out).toContain("CRASHED");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the slice of `text` from the first line that contains `storyId`
 * up to the next blank-line separator. Returns "" if not found.
 */
function extractStoryBlock(text: string, storyId: string): string {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((l) => l.includes(storyId));
  if (startIdx < 0) return "";
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => l.trim() === "");
  if (endIdx < 0) return rest.join("\n");
  return rest.slice(0, endIdx).join("\n");
}