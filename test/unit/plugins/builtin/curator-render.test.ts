/**
 * Curator Render Tests
 *
 * Tests for markdown rendering of proposals.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { assertDefined, makeNaxConfig, withTempDir } from "@test/helpers";
import { CuratorConfigSchema } from "@/config/schemas-infra";
import type { CuratorPostRunContext, Observation } from "@/plugins/builtin/curator";
import { curatorPlugin } from "@/plugins/builtin/curator";
import type { Proposal } from "@/plugins/builtin/curator/heuristics";
import { renderProposals } from "@/plugins/builtin/curator/render";
import { appendToRollup } from "@/plugins/builtin/curator/rollup";
import type { PostRunContext } from "@/plugins/extensions";

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
    // Assert the rendered token, not a bare digit: the header's own
    // timestamp always contains "20" (from its "2026-…" year), so a naive
    // `toContain("20")` would pass even if the run-count segment were deleted.
    expect(markdown).toContain("20 run(s)");
    expect(markdown).toContain("4000 window observation(s)");
  });

  test("AC1 (boundary): zero-window provenance still surfaces the zero in the header", () => {
    const markdown = renderProposals([provenanceBaseProposal], "run-x", 0, {
      runCount: 0,
      observationCount: 0,
    });
    expect(markdown).toContain("0 run(s) · 0 window observation(s)");
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
    // Capture the rendered values rather than counting "5" occurrences: the
    // header's own timestamp can itself contain digit "5"s, which would let
    // a naive occurrence count pass even with both fields deleted.
    const markdown = renderProposals([provenanceBaseProposal], "run-x", 5, {
      runCount: 1,
      observationCount: 5,
    });
    expect(markdown.match(/(\d+)\s+window observation/)?.[1]).toBe("5");
    expect(markdown.match(/(\d+)\s+run observation/)?.[1]).toBe("5");
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

    // Assert the rendered tokens, not a bare "0" — the header's own
    // "2026-…" timestamp always contains a "0" digit, so a naive
    // `toContain("0")` would pass even with the whole provenance segment
    // deleted from render.ts.
    expect(markdown).toMatch(/1\s+run/);
    expect(markdown).toContain("0 window observation(s)");
    expect(markdown).toContain("0 run observation(s)");
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

// ---- absorbed from test/unit/plugins/builtin/curator-us-003-postrun.test.ts ----

/**
 * Minimal curator post-run context pointing at the supplied directories.
 * Artifact directories under `outputDir` are intentionally absent so
 * `collectObservations` returns [] (it is graceful about missing sources),
 * giving the test full control over what the rollup contains.
 */
function makePostRunContext(opts: {
  outputDir: string;
  globalDir: string;
  curatorRollupPath: string;
  runId: string;
  projectKey: string;
}): CuratorPostRunContext {
  return {
    runId: opts.runId,
    feature: "feat-test",
    workdir: path.join(opts.outputDir, "work"),
    prdPath: path.join(opts.outputDir, "work", ".nax", "features", "feat-test", "prd.json"),
    branch: "main",
    totalDurationMs: 1000,
    totalCost: 10,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: makeNaxConfig(),
    outputDir: opts.outputDir,
    globalDir: opts.globalDir,
    projectKey: opts.projectKey,
    curatorRollupPath: opts.curatorRollupPath,
  };
}

/** A trivial review-finding observation for a given runId, suitable for the rollup. */
function makeReviewFindingObs(runId: string): Observation {
  return {
    schemaVersion: 3,
    projectKey: "test-project",
    runId,
    featureId: "feat-test",
    storyId: "US-001",
    stage: "review",
    ts: "2026-05-04T00:00:00Z",
    kind: "review-finding",
    payload: { ruleId: "rule-x", severity: "error", file: "src/a.ts", line: 1, message: "x" },
  };
}

describe("curator post-run action — heuristic-window provenance wiring (US-003)", () => {
  test("AC6: written curator-proposals.md header states the window run count when the rollup holds >1 run", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const runId = "current-run";
      const projectKey = "test-project";

      // Pre-populate the rollup with observations from TWO prior runs. The
      // current run's window therefore spans 3 distinct runIds (the two
      // historical plus its own, appended at execute-time).
      await appendToRollup([makeReviewFindingObs("historical-run-1")], rollupPath);
      await appendToRollup([makeReviewFindingObs("historical-run-2")], rollupPath);

      const ctx = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId,
        projectKey,
      });

      const postRunAction = curatorPlugin.extensions.postRunAction;
      expect(postRunAction).toBeDefined();
      await postRunAction?.execute(ctx);

      const proposalsPath = path.join(outputDir, "runs", runId, "curator-proposals.md");
      const md = await Bun.file(proposalsPath).text();

      // The header must carry the window's run count, not the literal "1" of
      // the per-run reading. The rollup holds two historical runs plus the
      // current run → window has at least 2 runIds.
      // (We assert "at least 2" rather than "exactly 3" because HEURISTIC_WINDOW_RUNS
      // caps at 20; for this fixture the window holds everything we appended.)
      expect(md).toMatch(/[2-9]\d*\s+run/);
    });
  });

  test("AC6 (boundary): single-run rollup still writes 'one run' in the header", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const runId = "current-run";

      // One historical observation from the SAME runId we're about to execute
      // as — the window collapses to that single runId.
      await appendToRollup([makeReviewFindingObs(runId)], rollupPath);

      const ctx = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId,
        projectKey: "test-project",
      });

      const postRunAction = curatorPlugin.extensions.postRunAction;
      await postRunAction?.execute(ctx);

      const md = await Bun.file(path.join(outputDir, "runs", runId, "curator-proposals.md")).text();
      expect(md).toMatch(/1\s+run/);
    });
  });

  test("AC8: empty rollup — header states one run and a window observation count equal to the current run's own count", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const runId = "current-run";

      // Seed outputDir with metrics.json whose stories will produce a known
      // number of observations. The test is non-tautological only when the
      // current run has a NON-ZERO observation count: with all zeros, a broken
      // implementation that always reports "0 window observations" still
      // passes — exactly the bug the AC exists to catch.
      //
      // Seven stories → seven verdict observations on the collector path. We
      // capture the value of the window observation token directly rather
      // than just checking that "7" occurs somewhere, so the test fails if
      // the implementation ever lists the window count as 0 while the run
      // count is 7 — exactly AC8's bug.
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        path.join(outputDir, "metrics.json"),
        JSON.stringify([
          {
            runId,
            feature: "feat-test",
            stories: Array.from({ length: 7 }, (_, i) => ({
              storyId: `US-${String(i + 1).padStart(3, "0")}`,
              success: true,
              attempts: 1,
              cost: 0,
            })),
          },
        ]),
      );

      const ctx = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId,
        projectKey: "test-project",
      });

      const postRunAction = curatorPlugin.extensions.postRunAction;
      await postRunAction?.execute(ctx);

      const md = await Bun.file(path.join(outputDir, "runs", runId, "curator-proposals.md")).text();
      // Empty rollup, this run has 7 observations → fallback provenance is
      // { runCount: 1, observationCount: 7 } and the run's own observation
      // count is also 7. The header must carry 7 both as the window
      // observation count and as the run observation count. A header that
      // reports "1 run(s) · 0 window observation(s) · 7 run observation(s)"
      // would NOT satisfy AC8 — the window count must equal the run's own.
      expect(md).toMatch(/1\s+run/);
      // Match the window observation count token directly — a header that
      // lists the window count as 0 but the run count as 7 would pass a
      // naive `toContain("7")` check, but does not satisfy AC8. Capturing
      // the value rather than counting occurrences is robust against
      // unrelated "7" substrings in the rendered markdown.
      const windowMatch = md.match(/(\d+)\s+window observation/);
      expect(windowMatch?.[1]).toBe("7");
      const runMatch = md.match(/(\d+)\s+run observation/);
      expect(runMatch?.[1]).toBe("7");
    });
  });
});

// ---- absorbed from test/unit/plugins/builtin/curator-acceptance.test.ts ----
describe("Curator Plugin Acceptance Criteria Coverage", () => {
  /**
   * AC1: Curator config supports enabled, rollupPath, and thresholds with schema/default/type coverage
   */
  test("AC1: CuratorConfigSchema supports all required fields", () => {
    const config = {
      enabled: true,
      rollupPath: "/home/user/.nax/curator/rollup.jsonl",
      thresholds: {
        repeatedFinding: 3,
        emptyKeyword: 2,
        rectifyAttempts: 3,
        escalationChain: 2,
        staleChunkRuns: 5,
        unchangedOutcome: 2,
      },
    };

    const result = CuratorConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  /**
   * AC2: Built-in nax-curator plugin is registered by default
   */
  test("AC2: curatorPlugin is provided as IPostRunAction", () => {
    expect(curatorPlugin.provides).toContain("post-run-action");
    expect(curatorPlugin.extensions.postRunAction).toBeDefined();
  });

  /**
   * AC8: curatorPlugin.shouldRun() works correctly
   */
  test("AC8: curatorPlugin has shouldRun method", async () => {
    const context: PostRunContext = {
      runId: "test",
      feature: "test",
      workdir: "/tmp",
      prdPath: "/tmp/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };

    const postRunAction = curatorPlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    const result = await postRunAction.shouldRun(context);
    expect(typeof result).toBe("boolean");
  });

  /**
   * AC9: curatorPlugin.execute() writes observations
   */
  test("AC9: curatorPlugin has execute method", async () => {
    const context: PostRunContext = {
      runId: "test",
      feature: "test",
      workdir: "/tmp",
      prdPath: "/tmp/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };

    const postRunAction = curatorPlugin.extensions.postRunAction;
    assertDefined(postRunAction, "postRunAction");
    const result = await postRunAction.execute(context);
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("message");
  });

  /**
   * AC10: PostRunContext extensions are backward compatible
   */
  test("AC10: PostRunContext is backward compatible without curator fields", () => {
    const context: PostRunContext = {
      runId: "test",
      feature: "test",
      workdir: "/tmp",
      prdPath: "/tmp/prd.json",
      branch: "main",
      totalDurationMs: 1000,
      totalCost: 10,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "0.1.0",
      pluginConfig: {},
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    };

    expect(context.runId).toBe("test");
    expect(context.outputDir).toBeUndefined();
  });
});
