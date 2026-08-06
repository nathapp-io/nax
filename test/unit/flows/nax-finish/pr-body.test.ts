/**
 * US-002 — deterministic finish PR title and body.
 *
 * The body is assembled by deterministic string joins over on-disk artifacts —
 * no model call. The renderer mirrors `escapeTableCell` so a `|` in a story
 * title cannot break its row, and mirrors `buildTitle` so finish-opened and
 * auto-PR-opened PRs read the same.
 */
import { describe, expect, test } from "bun:test";
import { buildFinishBody, buildFinishTitle } from "@flows/nax-finish/steps/pr-body";
import type { FinishPrContext, FinishPrStory } from "@flows/nax-finish/steps/pr-body";
import type { Finding, FinishRound } from "@flows/nax-finish/types";

const story = (over: Partial<FinishPrStory> = {}): FinishPrStory => ({
  id: "US-001",
  title: "Wire header",
  acCount: 3,
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "HIGH",
  title: "Spec mismatch",
  problem: "p",
  fix: "f",
  ...over,
});

const committedRound = (
  over: Partial<FinishRound> & { sha?: string } = {},
): FinishRound => ({
  ts: "2026-01-01T00:00:00.000Z",
  phase: "spec",
  attempt: 1,
  committed: true,
  findings: [],
  ...over,
});

const baseCtx = (over: Partial<FinishPrContext> = {}): FinishPrContext => ({
  feature: "auto-pr-plugin",
  stories: [],
  outOfScope: [],
  gatesRan: [],
  rounds: [],
  run: {},
  ...over,
});

describe("buildFinishTitle (US-002 AC1)", () => {
  test("returns 'feat: <feature>' for the supplied feature", () => {
    expect(buildFinishTitle(baseCtx({ feature: "auto-pr-plugin" }))).toBe("feat: auto-pr-plugin");
  });

  test("matches the buildTitle format used by the auto-PR plugin", () => {
    // Identical title shape so finish-opened and auto-PR-opened PRs read the same.
    expect(buildFinishTitle(baseCtx({ feature: "pipeline-run-outcome" }))).toBe("feat: pipeline-run-outcome");
  });
});

describe("buildFinishBody — Stories table (US-002 AC2, AC3)", () => {
  test("renders one table row per story", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [
          story({ id: "US-001", title: "Header", acCount: 2 }),
          story({ id: "US-002", title: "Footer", acCount: 4 }),
        ],
      }),
    );
    expect(body).toContain("| US-001 | Header | 2 |");
    expect(body).toContain("| US-002 | Footer | 4 |");
  });

  test("escapes '|' in story titles so the row remains three columns", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [story({ id: "US-001", title: "Audit | stub rows", acCount: 1 })],
      }),
    );
    expect(body).toContain("| US-001 | Audit \\| stub rows | 1 |");
    // The literal unescaped form must NOT appear in the row.
    expect(body).not.toMatch(/\|\s*Audit\s*\|\s*stub rows\s*\|\s*1\s*\|/);
  });
});

describe("buildFinishBody — Verification block (US-002 AC4-AC7)", () => {
  test("renders the acceptance Verification line when acceptance is present", () => {
    const body = buildFinishBody(baseCtx({ acceptance: "all 12 acceptance tests passed" }));
    expect(body).toContain("Verification");
    expect(body).toContain("Acceptance: all 12 acceptance tests passed");
  });

  test("renders the regression Verification line when regression is present", () => {
    const body = buildFinishBody(baseCtx({ regression: "regression suite green" }));
    expect(body).toContain("Regression: regression suite green");
  });

  test("renders every gate name in a single Verification line", () => {
    const body = buildFinishBody(baseCtx({ gatesRan: ["lint", "typecheck", "test"] }));
    expect(body).toContain("Gates: lint, typecheck, test");
  });

  test("includes the diffstat text verbatim in Verification when present", () => {
    const stat = " src/foo.ts | 12 ++++--\n 1 file changed, 9 insertions(+), 3 deletions(-)";
    const body = buildFinishBody(baseCtx({ diffstat: stat }));
    expect(body).toContain(stat);
  });
});

describe("buildFinishBody — Review rounds (US-002 AC8-AC12)", () => {
  test("renders one heading per round naming phase and attempt", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [
          committedRound({ phase: "spec", attempt: 1 }),
          committedRound({ phase: "quality", attempt: 2 }),
        ],
      }),
    );
    expect(body).toContain("## Review rounds");
    expect(body).toContain("### spec attempt 1");
    expect(body).toContain("### quality attempt 2");
  });

  test("renders each finding as a bullet carrying severity and title", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [
          committedRound({
            findings: [
              finding({ severity: "CRITICAL", title: "Spec drift in test" }),
              finding({ severity: "LOW", title: "Naming inconsistency" }),
            ],
          }),
        ],
      }),
    );
    expect(body).toContain("- [CRITICAL] Spec drift in test");
    expect(body).toContain("- [LOW] Naming inconsistency");
  });

  test("renders the abbreviated seven-character SHA in the round heading when committed", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [committedRound({ sha: "abcdef1234567" })],
      }),
    );
    expect(body).toContain("### spec attempt 1 (abcdef1)");
  });

  test("renders no SHA in the round heading when the round is uncommitted", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [
          {
            ts: "2026-01-01T00:00:00.000Z",
            phase: "spec",
            attempt: 1,
            committed: false,
            findings: [],
          },
        ],
      }),
    );
    expect(body).toContain("### spec attempt 1");
    expect(body).not.toMatch(/### spec attempt 1 \([0-9a-f]{7}\)/);
  });

  test("renders no Review rounds heading when rounds is empty", () => {
    const body = buildFinishBody(baseCtx({ rounds: [] }));
    expect(body).not.toContain("## Review rounds");
  });
});

describe("buildFinishBody — Out of scope (US-002 AC13, AC14)", () => {
  test("renders one bullet per out-of-scope entry, text unchanged", () => {
    const body = buildFinishBody(
      baseCtx({
        outOfScope: ["A model-written summary section", "Auto-PR template behaviour"],
      }),
    );
    expect(body).toContain("## Out of scope");
    expect(body).toContain("- A model-written summary section");
    expect(body).toContain("- Auto-PR template behaviour");
  });

  test("renders no Out of scope heading when the list is empty", () => {
    const body = buildFinishBody(baseCtx({ outOfScope: [] }));
    expect(body).not.toContain("## Out of scope");
  });
});

describe("buildFinishBody — Run summary footer (US-002 AC15)", () => {
  test("renders story counts and duration in 'Nm SSs' format", () => {
    const body = buildFinishBody(
      baseCtx({
        run: { storiesPassed: 4, storiesTotal: 5, durationMs: 92_000 },
      }),
    );
    // AC15: "<storiesPassed>/<storiesTotal> stories · <durationMs formatted as Nm SSs>"
    // — one line, joined by ' · '. A regression that swaps the separator or
    // breaks the line would survive `toContain` on each half independently.
    expect(body).toContain("4/5 stories · 1m 32s");
  });

  test("omits the footer when duration is absent and reports only counts when duration is provided", () => {
    expect(buildFinishBody(baseCtx({ run: { storiesPassed: 1, storiesTotal: 1 } }))).toContain("1/1 stories");
    const body = buildFinishBody(baseCtx({ run: { durationMs: 65_000 } }));
    expect(body).toContain("1m 05s");
  });

  test("non-finite duration formats as '0m 00s' instead of propagating NaN/Infinity into the body", () => {
    // NaN/Infinity are valid TypeScript `number` values and `Math.max(0, NaN)`
    // propagates NaN, so a guard is required to avoid `"NaNm NaNs"` in the PR.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const body = buildFinishBody(baseCtx({ run: { storiesPassed: 1, storiesTotal: 1, durationMs: bad } }));
      expect(body).toContain("1/1 stories · 0m 00s");
    }
  });
});

describe("buildFinishBody — repository template (#1478)", () => {
  test("appends the template verbatim after every deterministic section", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [story({ id: "US-001", title: "Header", acCount: 2 })],
        template: "## Checklist\n- [ ] docs updated",
      }),
    );
    expect(body.endsWith("## Checklist\n- [ ] docs updated")).toBe(true);
    expect(body.indexOf("## Stories")).toBeLessThan(body.indexOf("## Checklist"));
  });

  test("omits the template entirely when none resolved", () => {
    const body = buildFinishBody(baseCtx({ stories: [story()] }));
    expect(body).not.toContain("## Checklist");
    expect(body.endsWith("\n\n")).toBe(false);
  });

  test("treats a whitespace-only template as absent", () => {
    const body = buildFinishBody(baseCtx({ stories: [story()], template: "   \n  " }));
    expect(body.trimEnd()).toBe(body);
  });
});

describe("buildFinishBody — What changed section (#1477)", () => {
  test("renders the narrative first, above the Stories table", () => {
    const body = buildFinishBody(
      baseCtx({ stories: [story()], narrative: "Replaced the widget cache." }),
    );
    expect(body.indexOf("## What changed")).toBe(0);
    expect(body).toContain("Replaced the widget cache.");
    expect(body.indexOf("## What changed")).toBeLessThan(body.indexOf("## Stories"));
  });

  test("omits the heading entirely when there is no narrative", () => {
    // #1477 forbids an empty heading. Heading and text are produced by one
    // function so this is structural, not a rule someone has to remember.
    const body = buildFinishBody(baseCtx({ stories: [story()] }));
    expect(body).not.toContain("## What changed");
  });

  test("treats a whitespace-only narrative as absent", () => {
    const body = buildFinishBody(baseCtx({ stories: [story()], narrative: "  \n " }));
    expect(body).not.toContain("## What changed");
  });
});
