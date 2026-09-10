import { describe, expect, test } from "bun:test";
import type { Finding, Iteration } from "@/findings";
import { buildPriorIterationsBlock } from "@/prompts/builders/prior-iterations-builder";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> & Pick<Finding, "source" | "message">): Finding {
  return {
    severity: "error",
    category: overrides.category ?? "stdout-capture",
    ...overrides,
  };
}

function makeIteration(
  overrides: Partial<Iteration<Finding>> & Pick<Iteration<Finding>, "iterationNum" | "outcome">,
): Iteration<Finding> {
  return {
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

// ─── Empty input ──────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — empty", () => {
  test("returns empty string for empty iterations array", () => {
    expect(buildPriorIterationsBlock([])).toBe("");
  });
});

// ─── Single iteration with findings ─────────────────────────────────────────

describe("buildPriorIterationsBlock — single round with findings", () => {
  test("renders Round header and finding text fields", () => {
    const finding = makeFinding({
      source: "adversarial-review",
      message: "Missing test for null input path",
      suggestion: "Add a test asserting the function throws on null",
      file: "src/foo.ts",
      line: 42,
      category: "test-gap",
      severity: "error",
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "regressed",
      findingsBefore: [],
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);

    expect(output).toContain("## Prior Iterations — verdict required before new analysis");
    expect(output).toContain("### Round 1 — outcome: regressed (0 → 1)");
    expect(output).toContain("Findings flagged previously:");
    expect(output).toContain("src/foo.ts:42");
    expect(output).toContain("[error / test-gap]");
    expect(output).toContain("Message: Missing test for null input path");
    expect(output).toContain("Suggestion: Add a test asserting the function throws on null");
  });

  test("shows (workdir-global) when finding has no file", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "missing script" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("(workdir-global)");
  });

  test("shows file without line when line is absent", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x", file: "src/bar.ts" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "partial",
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("src/bar.ts");
    expect(output).not.toContain("src/bar.ts:");
  });

  test("renders _All prior findings cleared_ when findingsAfter is empty", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "resolved",
      findingsBefore: [finding],
      findingsAfter: [],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("### Round 1 — outcome: resolved (1 → 0)");
    expect(output).toContain("_All prior findings cleared._");
    expect(output).not.toContain("Findings flagged previously:");
  });
});

// ─── acQuote field ────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — acQuote", () => {
  test("renders acQuote line when meta.acQuote is a string", () => {
    const finding = makeFinding({
      source: "adversarial-review",
      message: "AC not covered",
      meta: { acQuote: "AC3: error path is covered" },
    });
    const iter = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain('acQuote: "AC3: error path is covered"');
  });

  test("omits acQuote line when meta is absent", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x" });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).not.toContain("acQuote:");
  });

  test("omits acQuote line when meta.acQuote is not a string", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x", meta: { acQuote: 42 } });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).not.toContain("acQuote:");
  });
});

// ─── Truncation ───────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — truncation", () => {
  test("truncates message longer than 240 chars", () => {
    const longMessage = "A".repeat(300);
    const finding = makeFinding({ source: "adversarial-review", message: longMessage });
    const iter = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("…");
    // The full 300-char message should not appear verbatim
    expect(output).not.toContain("A".repeat(300));
  });

  test("does not truncate message at or under 240 chars", () => {
    const exactMessage = "B".repeat(240);
    const finding = makeFinding({ source: "adversarial-review", message: exactMessage });
    const iter = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("B".repeat(240));
  });
});

// ─── Verdict template ─────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — verdict template", () => {
  test("includes verdict template with correct total count", () => {
    const f1 = makeFinding({ source: "adversarial-review", message: "a" });
    const f2 = makeFinding({ source: "adversarial-review", message: "b" });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [f1, f2] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("classify each of the 2 prior finding(s) above");
    expect(output).toContain("`addressed`");
    expect(output).toContain("`still-blocking`");
    expect(output).toContain("`never-an-issue`");
  });

  test("sums findingsAfter across multiple iterations for total count", () => {
    const f1 = makeFinding({ source: "adversarial-review", message: "x" });
    const f2 = makeFinding({ source: "adversarial-review", message: "y" });
    const f3 = makeFinding({ source: "adversarial-review", message: "z" });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsBefore: [], findingsAfter: [f1] });
    const iter2 = makeIteration({
      iterationNum: 2,
      outcome: "unchanged",
      findingsBefore: [f1],
      findingsAfter: [f2, f3],
    });

    const output = buildPriorIterationsBlock([iter1, iter2]);
    expect(output).toContain("classify each of the 3 prior finding(s) above");
  });

  test("routes addressed / never-an-issue verdicts to `acks`, not to findings (#1423)", () => {
    // An acknowledgement is not a defect. Emitting it as a finding inflates
    // finding telemetry and pollutes curator proposal evidence.
    const finding = makeFinding({ source: "adversarial-review", message: "a" });
    const output = buildPriorIterationsBlock([
      makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [finding] }),
    ]);

    expect(output).toContain("`acks`");
    // The two non-blocking verdicts must be explicitly directed away from findings.
    expect(output).toMatch(/`addressed`[^\n]*acks/i);
    expect(output).toMatch(/`never-an-issue`[^\n]*acks/i);
    // still-blocking remains a real finding — it is a defect the implementer left.
    expect(output).toMatch(/`still-blocking`[^\n]*re-flag/i);
    expect(output).toContain("Do NOT emit an acknowledgement as a finding");
  });

  test("does NOT include FALSIFIED note when no unchanged iterations", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x" });
    const iter = makeIteration({ iterationNum: 1, outcome: "resolved", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).not.toContain("FALSIFIED");
  });
});

// ─── Unchanged outcome ────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — unchanged outcome", () => {
  test("includes falsified-hypothesis note when any iteration is unchanged", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x", category: "test-gap" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsBefore: [finding],
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain('outcome is "unchanged", the prior hypothesis is FALSIFIED');
    expect(output).toContain("Do NOT repeat fixes listed above.");
  });

  test("includes FALSIFIED note even when only one of multiple iterations is unchanged", () => {
    const f = makeFinding({ source: "adversarial-review", message: "x" });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsBefore: [], findingsAfter: [f] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsBefore: [f], findingsAfter: [f] });

    const output = buildPriorIterationsBlock([iter1, iter2]);
    expect(output).toContain("FALSIFIED");
  });
});

// ─── Multiple iterations ──────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — multiple iterations", () => {
  test("renders all rounds in order with correct headers", () => {
    const f = makeFinding({ source: "adversarial-review", message: "finding" });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsBefore: [], findingsAfter: [f] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsBefore: [f], findingsAfter: [f] });
    const iter3 = makeIteration({ iterationNum: 3, outcome: "resolved", findingsBefore: [f], findingsAfter: [] });

    const output = buildPriorIterationsBlock([iter1, iter2, iter3]);

    expect(output).toContain("### Round 1 — outcome: partial");
    expect(output).toContain("### Round 2 — outcome: unchanged");
    expect(output).toContain("### Round 3 — outcome: resolved");
    // Rounds appear in order
    const r1Pos = output.indexOf("### Round 1");
    const r2Pos = output.indexOf("### Round 2");
    const r3Pos = output.indexOf("### Round 3");
    expect(r1Pos).toBeLessThan(r2Pos);
    expect(r2Pos).toBeLessThan(r3Pos);
  });

  test("numbers findings within a round starting at 1", () => {
    const f1 = makeFinding({ source: "adversarial-review", message: "first" });
    const f2 = makeFinding({ source: "adversarial-review", message: "second" });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [f1, f2] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("1. [");
    expect(output).toContain("2. [");
  });
});

// ─── Token guard ──────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — token guard", () => {
  test("collapses oldest rounds to one-liners when content exceeds MAX_BLOCK_CHARS", () => {
    // 4 findings × 5 iterations ≈ 6600 chars → exceeds 6000-char budget
    const verboseMessage = "X".repeat(300);
    const perRoundFindings = Array.from({ length: 4 }, (_, j) =>
      makeFinding({ source: "adversarial-review", message: `${verboseMessage}-${j}`, file: "src/big.ts", line: j + 1 }),
    );
    const iterations = Array.from({ length: 5 }, (_, i) =>
      makeIteration({ iterationNum: i + 1, outcome: "unchanged", findingsBefore: [], findingsAfter: perRoundFindings }),
    );

    const output = buildPriorIterationsBlock(iterations);

    // Oldest rounds (1, 2, 3) collapsed to one-liners
    expect(output).toContain("Round 1 — outcome: unchanged (4 findings, omitted for brevity)");
    expect(output).toContain("Round 2 — outcome: unchanged (4 findings, omitted for brevity)");
    expect(output).toContain("Round 3 — outcome: unchanged (4 findings, omitted for brevity)");
    // Most recent 2 rounds (4, 5) rendered verbatim
    expect(output).toContain("### Round 4 — outcome: unchanged");
    expect(output).toContain("### Round 5 — outcome: unchanged");
    expect(output).toContain("Message:");
  });

  test("never collapses when 2 or fewer iterations even if large", () => {
    const verboseMessage = "Y".repeat(1000);
    const f1 = makeFinding({ source: "adversarial-review", message: verboseMessage });
    const f2 = makeFinding({ source: "adversarial-review", message: verboseMessage });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [f1] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsAfter: [f2] });

    const output = buildPriorIterationsBlock([iter1, iter2]);

    // Both rounds rendered verbatim even though content is large
    expect(output).toContain("### Round 1 — outcome: partial");
    expect(output).toContain("### Round 2 — outcome: unchanged");
    expect(output).not.toContain("omitted for brevity");
  });

  test("verdict count uses only visible rounds after collapse", () => {
    // iter1 (7) + iter2 (6) → collapsed; iter3 (3) + iter4 (3) → visible → total = 6
    const verboseMessage = "Z".repeat(300);
    const makeFindings = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeFinding({ source: "adversarial-review", message: `${verboseMessage}-${i}`, file: "src/big.ts", line: i }),
      );
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: makeFindings(7) });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsAfter: makeFindings(6) });
    const iter3 = makeIteration({ iterationNum: 3, outcome: "unchanged", findingsAfter: makeFindings(3) });
    const iter4 = makeIteration({ iterationNum: 4, outcome: "unchanged", findingsAfter: makeFindings(3) });

    const output = buildPriorIterationsBlock([iter1, iter2, iter3, iter4]);

    // Only rounds 3 and 4 are visible (last 2), each with 3 findings → total = 6
    expect(output).toContain("classify each of the 6 prior finding(s) above");
  });

  test("FALSIFIED note absent when only collapsed rounds have outcome=unchanged", () => {
    // Rounds 1–2 are "unchanged" (will be collapsed); rounds 3–4 are "partial" (visible).
    // verdictTemplate must NOT show the FALSIFIED note because no visible round is unchanged.
    const verboseMessage = "W".repeat(300);
    const makeFindings = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeFinding({ source: "adversarial-review", message: `${verboseMessage}-${i}`, file: "src/big.ts", line: i }),
      );
    const iter1 = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: makeFindings(5) });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsAfter: makeFindings(5) });
    const iter3 = makeIteration({ iterationNum: 3, outcome: "partial", findingsAfter: makeFindings(5) });
    const iter4 = makeIteration({ iterationNum: 4, outcome: "partial", findingsAfter: makeFindings(5) });

    const output = buildPriorIterationsBlock([iter1, iter2, iter3, iter4]);

    // Collapsed rounds are not shown verbatim, so FALSIFIED note must not appear
    expect(output).toContain("omitted for brevity");
    expect(output).not.toContain("FALSIFIED");
  });
});

// ─── US-004: retired findings (rendering change) ─────────────────────────────

describe("buildPriorIterationsBlock — retired findings", () => {
  // AC 1 — finding stamped meta.recurrence.disposition retired is omitted
  // from the verdict-required list.
  test("omits a retired-stamped finding from the verdict-required list", () => {
    const retired = makeFinding({
      source: "adversarial-review",
      message: "tired warning that the implementer has seen enough times",
      file: "src/lib/foo.ts",
      category: "input",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [retired],
    });

    const output = buildPriorIterationsBlock([iter]);

    // The retired finding's message must not appear in the per-finding list
    // (renderFinding is what produces the "Findings flagged previously:" entries).
    expect(output).not.toContain("tired warning that the implementer has seen enough times");
    // The iteration must not advertise it as a still-flaggable finding.
    expect(output).not.toContain("Findings flagged previously:");
  });

  // AC 2 — acknowledgement section names the finding's file and category.
  test("acknowledgement section names the retired finding's file and category", () => {
    const retired = makeFinding({
      source: "adversarial-review",
      message: "tired advisory",
      file: "src/lib/foo.ts",
      category: "input",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [retired],
    });

    const output = buildPriorIterationsBlock([iter]);

    // The acknowledgement section must surface the file and category of every retired finding.
    expect(output).toContain("src/lib/foo.ts");
    expect(output).toContain("input");
    // And it must be distinguishable from the verdict list.
    expect(output).toContain("Acknowledg");
  });

  // AC 3 — acknowledgement section states the retired findings are closed and
  // must not be re-flagged.
  test("acknowledgement section states retired findings are closed and must not be re-flagged", () => {
    const retired = makeFinding({
      source: "adversarial-review",
      message: "tired advisory",
      file: "src/lib/foo.ts",
      category: "input",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [retired],
    });

    const output = buildPriorIterationsBlock([iter]);

    // Both phrases are required by AC 3.
    expect(output).toMatch(/closed/i);
    expect(output).toMatch(/must not be re-?flagged/i);
  });

  // AC 4 — block is unchanged when no finding carries meta.recurrence.
  test("returns the same block when no finding carries meta.recurrence", () => {
    const f = makeFinding({
      source: "adversarial-review",
      message: "plain finding",
      file: "src/lib/foo.ts",
      category: "input",
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "regressed",
      findingsBefore: [],
      findingsAfter: [f],
    });

    const output = buildPriorIterationsBlock([iter]);

    // Pre-feature behaviour: the finding appears in the verdict-required list and
    // no acknowledgement section is rendered (no retired entries exist).
    expect(output).toContain("Findings flagged previously:");
    expect(output).toContain("plain finding");
    expect(output).not.toContain("Acknowledg");
  });

  // AC 5 — verdict template count only includes non-retired findings.
  test("verdict template counts only findings not stamped retired", () => {
    const live = makeFinding({
      source: "adversarial-review",
      message: "still-blocking issue",
      file: "src/lib/live.ts",
      category: "input",
    });
    const retired = makeFinding({
      source: "adversarial-review",
      message: "tired issue",
      file: "src/lib/tired.ts",
      category: "input",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [live, retired],
    });

    const output = buildPriorIterationsBlock([iter]);

    // 1 live + 1 retired → count must be 1 (retired excluded from verdict count).
    expect(output).toContain("classify each of the 1 prior finding(s) above");
    expect(output).not.toContain("classify each of the 2 prior finding(s) above");
  });

  // AC 6 — an iteration whose findings are all retired renders no
  // verdict-required list (the iteration body becomes acknowledgement-only).
  test("an iteration whose findings are all stamped retired has no verdict-required list", () => {
    const retired1 = makeFinding({
      source: "adversarial-review",
      message: "tired issue one",
      file: "src/lib/a.ts",
      category: "input",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const retired2 = makeFinding({
      source: "adversarial-review",
      message: "tired issue two",
      file: "src/lib/b.ts",
      category: "error-path",
      meta: { recurrence: { disposition: "retired", rounds: 3, wasBlocking: false } },
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [retired1, retired2],
    });

    const output = buildPriorIterationsBlock([iter]);

    // The verdict-required list is the per-finding block under "Findings flagged previously:".
    expect(output).not.toContain("Findings flagged previously:");
    // The verdict template must still appear, but its count is 0 (no live entries
    // in this iteration).
    expect(output).toContain("classify each of the 0 prior finding(s) above");
    // And the acknowledgement section must list the two retired files/categories.
    expect(output).toContain("src/lib/a.ts");
    expect(output).toContain("src/lib/b.ts");
  });

  // AC 7 — across three rounds where a warning is emitted in round 1 and reaches
  // maxAdvisoryRounds in round 2, the round-3 prior-iterations block lists it
  // only in the acknowledgement section.
  test("across three rounds the retired warning is listed only in the acknowledgement section", () => {
    // The store carries the SAME finding across rounds (same file/line/rule;
    // message may be re-worded by the reviewer, but classifyRecurrence matches
    // it back via fingerprintFor). Round 1's copy is unstamped because the
    // plain advisory bucket is never recurrence-stamped (US-001); round 2's
    // copy is stamped retired because the advisory cap was reached. The
    // round-3 prompt must NOT re-flag the defect from round 1's verdict list
    // and acknowledge it in round 2's section at the same time — that's the
    // loop retirement exists to break.
    const w = (msg: string): Finding =>
      makeFinding({
        source: "adversarial-review",
        message: msg,
        file: "src/lib/w.ts",
        line: 42,
        category: "input",
        severity: "warning",
      });
    const round1 = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [w("warning text")],
    });
    const round2 = makeIteration({
      iterationNum: 2,
      outcome: "unchanged",
      findingsAfter: [
        // Round 2 — stamped retired by classifyRecurrence (advisory cap reached).
        // Same file/line/rule, message re-worded by the reviewer.
        {
          ...w("warning text reworded"),
          meta: { recurrence: { disposition: "retired", rounds: 2, wasBlocking: false } },
        },
      ],
    });
    const round3 = makeIteration({
      iterationNum: 3,
      outcome: "unchanged",
      findingsAfter: [],
    });

    // The block is what round 4 would see — three rounds of history.
    const output = buildPriorIterationsBlock([round1, round2, round3]);

    // The retired defect's file path must appear exactly once across the
    // entire block (in the acknowledgement section). It MUST NOT appear in
    // any round's verdict-required list.
    const fileOccurrences = output.split("src/lib/w.ts").length - 1;
    expect(fileOccurrences).toBe(1);
    // The file/category pair is in the acknowledgement, not the verdict list.
    expect(output).toContain("Acknowledgement — closed findings");
    // The verdict-required list contains nothing for this round-1 finding.
    expect(output).not.toMatch(/Findings flagged previously:[\s\S]*?src\/lib\/w\.ts/);
  });

  // Round 3 prior block — round-2 retired finding listed once in acknowledgement.
  test("retired finding in round 2 is named only in round 2's acknowledgement section", () => {
    const retired = makeFinding({
      source: "adversarial-review",
      message: "single tired message",
      file: "src/lib/single.ts",
      category: "input",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [retired] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsAfter: [] });

    const output = buildPriorIterationsBlock([iter1, iter2]);

    // The retired finding must appear once across the block — in the global
    // acknowledgement section, since iter2 carries no findings at all.
    const occurrences = output.split("src/lib/single.ts").length - 1;
    expect(occurrences).toBe(1);
  });

  // Adversarial review #1 (US-004) — when the same finding carries no stamp
  // in round 1 but is stamped retired in round 2, the round-1 copy must NOT
  // reappear in the verdict-required list. The store genuinely carries two
  // states of the same defect (US-001 only stamps the retired entry, not
  // earlier plain-advisory copies), and a per-iteration "is THIS copy
  // retired?" check would let round 1's unstamped copy re-flag the defect
  // while round 2's stamped copy tells the reviewer not to. The block
  // therefore looks at the WHOLE history and treats the finding as retired
  // for the purposes of the verdict list once any iteration has stamped it.
  test("an unstamped round-1 copy of a defect retired in round 2 is suppressed from the verdict list", () => {
    const round1 = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [
        makeFinding({
          source: "adversarial-review",
          message: "unstamped advisory copy",
          file: "src/lib/dup.ts",
          line: 7,
          category: "input",
          severity: "warning",
        }),
      ],
    });
    const round2 = makeIteration({
      iterationNum: 2,
      outcome: "unchanged",
      findingsAfter: [
        {
          source: "adversarial-review",
          message: "stamped retired copy (re-worded)",
          file: "src/lib/dup.ts",
          line: 7,
          category: "input",
          severity: "warning",
          meta: { recurrence: { disposition: "retired", rounds: 2, wasBlocking: false } },
        },
      ],
    });

    const output = buildPriorIterationsBlock([round1, round2]);

    // The defect's file must appear EXACTLY once in the block (in the
    // acknowledgement). It must NOT appear in the verdict-required list of
    // round 1.
    const fileOccurrences = output.split("src/lib/dup.ts").length - 1;
    expect(fileOccurrences).toBe(1);
    // The acknowledgement section names the retired file.
    expect(output).toContain("Acknowledgement — closed findings");
    // No "Findings flagged previously:" line should reference the retired file.
    expect(output).not.toMatch(/Findings flagged previously:[\s\S]*?src\/lib\/dup\.ts/);
    // The verdict template count must exclude the retired finding entirely.
    expect(output).toContain("classify each of the 0 prior finding(s) above");
  });
});
