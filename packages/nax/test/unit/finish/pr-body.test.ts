/**
 * US-002 — deterministic finish PR title and body.
 *
 * The body is assembled by deterministic string joins over on-disk artifacts —
 * no model call. The renderer mirrors `escapeTableCell` so a `|` in a story
 * title cannot break its row, and mirrors `buildTitle` so finish-opened and
 * auto-PR-opened PRs read the same.
 */
import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import type { AdviceDecision } from "@/advisor";
import type { Finding, FinishPrContext, FinishPrStory, FinishRound, LedgerEntry } from "@/finish";
import { buildFinishBody, buildFinishTitle, resolveTitle } from "@/finish";

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

const committedRound = (over: Partial<FinishRound> & { sha?: string } = {}): FinishRound => ({
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
  title: "feat: auto-pr-plugin",
  ...over,
});

describe("buildFinishTitle (US-002 AC1)", () => {
  test("renders the resolved conventional-commit title", () => {
    const ctx = baseCtx({ feature: "schema-drift-gate", title: "fix: make the Alembic drift gate able to fail" });
    expect(buildFinishTitle(ctx)).toBe("fix: make the Alembic drift gate able to fail");
  });

  test("renders the 'feat: <feature>' fallback that resolveTitle supplies", () => {
    // The floor is still the auto-PR plugin's shape, so a finish run whose
    // branch review supplied no title reads the same as an auto-PR-opened one.
    expect(buildFinishTitle(baseCtx({ title: resolveTitle(undefined, "pipeline-run-outcome") }))).toBe(
      "feat: pipeline-run-outcome",
    );
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

  test("accounts for the held-out nax artifacts so the body reconciles with the real diff", () => {
    const body = buildFinishBody(baseCtx({ artifactSummary: "5 files changed, 1248 insertions(+)" }));
    expect(body).toContain("Excluded from diffstat — nax run artifacts: 5 files changed, 1248 insertions(+)");
  });

  test("renders no exclusion line when the branch touched no artifacts", () => {
    const body = buildFinishBody(baseCtx({ diffstat: " src/foo.ts | 1 +" }));
    expect(body).not.toContain("Excluded from diffstat");
  });
});

describe("buildFinishBody — Review (US-002 AC8-AC12)", () => {
  test("renders one heading per round naming phase and attempt", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [committedRound({ phase: "spec", attempt: 1 }), committedRound({ phase: "quality", attempt: 2 })],
      }),
    );
    expect(body).toContain("## Review");
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

  test("a rejected finding is rendered as waived, with its evidence", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [
          committedRound({
            phase: "quality",
            outcome: "fixed",
            findings: [finding({ severity: "LOW", title: "Dead param" })],
            dispositions: [{ index: 1, disposition: "rejected", evidence: "test/unit/a.test.ts:9" }],
          }),
        ],
      }),
    );
    expect(body).toContain("_rejected_");
    expect(body).toContain("test/unit/a.test.ts:9");
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

  test("renders no Review heading when rounds is empty", () => {
    const body = buildFinishBody(baseCtx({ rounds: [] }));
    expect(body).not.toContain("## Review");
  });
});

// #1507: an empty finding list means four different things, and the body used
// to render all of them as "_no findings_" — which a human reads as "a reviewer
// looked and approved this". Only `passed` means that.
describe("buildFinishBody — what an empty round actually means", () => {
  const emptyRound = (over: Partial<FinishRound> = {}): FinishRound => ({
    ts: "2026-01-01T00:00:00.000Z",
    phase: "quality",
    attempt: 1,
    committed: false,
    findings: [],
    ...over,
  });

  test("a passed review still reads as no findings", () => {
    const body = buildFinishBody(baseCtx({ rounds: [emptyRound({ outcome: "passed" })] }));
    expect(body).toContain("- _no findings_");
  });

  test("a gate round says no reviewer ran, NOT that a reviewer found nothing", () => {
    const body = buildFinishBody(baseCtx({ rounds: [emptyRound({ phase: "gate", outcome: "no-reviewer" })] }));
    expect(body).toContain("### gate attempt 1");
    expect(body).toContain("no reviewer");
    expect(body).not.toContain("- _no findings_");
  });

  // The reader has to be able to see the skip. A PR whose gate fix bypassed the
  // re-review by policy looks, in every other respect, exactly like one that was
  // re-reviewed and came back clean.
  test("a skipped re-review is visible in the body, not disguised as a clean one", () => {
    const body = buildFinishBody(baseCtx({ rounds: [emptyRound({ phase: "gate", outcome: "review-skipped" })] }));
    expect(body).toContain("re-review skipped");
    expect(body).not.toContain("- _no findings_");
  });

  test("an unparseable review is not rendered as a pass", () => {
    const body = buildFinishBody(baseCtx({ rounds: [emptyRound({ outcome: "unparseable" })] }));
    expect(body).toContain("could not be parsed");
    expect(body).not.toContain("- _no findings_");
  });

  test("an advised round says the advisor ruled — not a pass (A1)", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [emptyRound({ outcome: "advised", advice: [{ decisionId: "D-3", optionId: "B", reused: false }] })],
      }),
    );
    expect(body).toContain("advisor ruled");
    expect(body).toContain("D-3");
    expect(body).not.toContain("- _no findings_");
  });

  test("an escalated review is not rendered as a pass", () => {
    const body = buildFinishBody(baseCtx({ rounds: [emptyRound({ outcome: "escalated" })] }));
    expect(body).toContain("escalated");
    expect(body).not.toContain("- _no findings_");
  });

  // Rounds written before `outcome` existed carry no such field. The body must
  // keep rendering them exactly as it did, rather than claiming they had no
  // reviewer — it does not know that.
  test("a legacy round with no outcome renders as before", () => {
    const body = buildFinishBody(baseCtx({ rounds: [emptyRound({})] }));
    expect(body).toContain("- _no findings_");
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

describe("buildFinishBody — repository template (#1478, merged per #1504)", () => {
  // Superseded the original #1478 contract ("append the template verbatim
  // last"), which shipped an unfilled form below a filled one — see
  // `pr-template-merge.ts`. The template is now shape, not trailing content.
  test("drops a template section nax cannot fill rather than shipping its blank checklist", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [story({ id: "US-001", title: "Header", acCount: 2 })],
        template: "## Checklist\n- [ ] docs updated",
      }),
    );
    expect(body).not.toContain("## Checklist");
    expect(body).not.toContain("- [ ] docs updated");
    expect(body).toContain("| US-001 | Header | 2 |");
  });

  test("adopts a template heading it can fill, and puts nax's content under it", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [story({ id: "US-001", title: "Header", acCount: 2 })],
        narrative: "Replaced the widget cache.",
        template: "## Summary\n\n<!-- describe -->\n\n## How\n\n<!-- details -->",
      }),
    );
    expect(body).toContain("## Summary\n\nReplaced the widget cache.");
    expect(body).toContain("## How\n\n| Story | Title | ACs |");
    expect(body).not.toContain("## What changed");
    expect(body).not.toContain("<!--");
  });

  test("keeps every unfillable heading, empty, under the strict mode a heading-checking CI needs", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [story()],
        template: "## Checklist\n- [ ] docs updated",
        templateMode: "strict",
      }),
    );
    expect(body).toContain("## Checklist");
    expect(body).not.toContain("- [ ] docs updated");
  });

  test("honours a sectionMap override for a heading the default table does not know", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [story({ id: "US-001", title: "Header", acCount: 2 })],
        template: "## Werk\n\n<!-- x -->",
        templateSectionMap: { werk: "stories" },
      }),
    );
    expect(body).toContain("## Werk\n\n| Story | Title | ACs |");
    expect(body).not.toContain("## Stories");
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
    const body = buildFinishBody(baseCtx({ stories: [story()], narrative: "Replaced the widget cache." }));
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

describe("buildFinishBody — Advisor decisions section (A1)", () => {
  const dec = (id: string, needsHumanConfirm: boolean, action: AdviceDecision["action"]): AdviceDecision => ({
    id,
    questionId: "Q",
    kind: "finish-judgment",
    storyId: "US-2",
    chosenOptionId: "A",
    action,
    rationale: `because ${id}`,
    confidence: "high",
    reversible: true,
    needsHumanConfirm,
    decidedAt: "t",
    model: "m",
    memoryMode: "stateless",
    auditRef: "a",
  });
  const decisions = [
    dec("D-1", false, { type: "fix", instruction: "x" }),
    dec("D-2", true, {
      type: "supersede",
      target: { kind: "ac", storyId: "US-2", acId: "AC-3" },
      newText: "returns 0",
    }),
  ];

  test("flagged decisions first, then the rest, then the spec amendments", () => {
    const body = buildFinishBody(baseCtx({ advisorDecisions: decisions }));
    expect(body).toContain("Advisor decisions");
    expect(body.indexOf("**D-2**")).toBeLessThan(body.indexOf("**D-1**"));
    expect(body).toContain("(needs confirmation)");
    expect(body).toContain("Spec amendments to apply");
    expect(body).toContain("US-2 AC-3: returns 0");
  });

  test("free text is flattened: no newlines, no HTML, capped", () => {
    const evil = makeAdviceDecision({
      ...decisions[0],
      rationale: `line1\n## Injected heading\n<img src=x onerror=1>${"z".repeat(600)}`,
    });
    const body = buildFinishBody(baseCtx({ advisorDecisions: [evil] }));
    expect(body).not.toContain("\n## Injected heading");
    expect(body).not.toContain("<img");
    expect(body).toContain("…");
  });

  test("absent when the advisor made no decisions", () => {
    expect(buildFinishBody(baseCtx({}))).not.toContain("Advisor decisions");
  });

  for (const mode of ["merge", "strict", "ignore"] as const) {
    test(`survives template mode ${mode}`, () => {
      const body = buildFinishBody(
        baseCtx({ advisorDecisions: decisions, template: "## Summary\n\n## Testing\n", templateMode: mode }),
      );
      expect(body).toContain("D-2");
    });
  }
});

describe("buildFinishBody — Unresolved and coverage (A4)", () => {
  const unresolved = (over: Partial<NonNullable<FinishPrContext["unresolved"]>> = {}) => ({
    reason: "",
    findings: [],
    acceptance: "green" as const,
    gates: [],
    missing: [],
    unreviewed: [],
    accepted: [],
    ledger: [],
    stops: [],
    handoffs: [],
    ...over,
  });

  test("draft body puts Unresolved first with reason, findings, red gates, missing reviews, unreviewed commits", () => {
    const body = buildFinishBody(
      baseCtx({
        narrative: "Prose.",
        stories: [story()],
        unresolved: unresolved({
          reason: "2 open finding(s), spec review missing",
          findings: [
            finding({ severity: "LOW", title: "Nit", file: "b.ts" }),
            finding({ severity: "HIGH", title: "Real bug", file: "a.ts", line: 4, source: "quality" }),
          ],
          acceptance: "red",
          gates: [{ name: "lint", status: "red", excerpt: "a.ts:1 unused" }],
          missing: ["spec"],
          unreviewed: ["abcdef1234567"],
        }),
      }),
    );
    expect(body.startsWith("## Unresolved")).toBe(true);
    expect(body.indexOf("## Unresolved")).toBeLessThan(body.indexOf("## What changed"));
    expect(body).toContain("2 open finding(s), spec review missing");
    expect(body.indexOf("Real bug")).toBeLessThan(body.indexOf("Nit"));
    expect(body).toContain("a.ts:4");
    expect(body).toContain("Acceptance: red");
    expect(body).toContain("lint");
    expect(body).toContain("a.ts:1 unused");
    expect(body).toContain("spec review");
    expect(body).toContain("abcdef1");
    expect(body).not.toContain("abcdef1234567");
  });

  test("ready body with accepted residue renders 'Accepted by the advisor'", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: unresolved({ accepted: [finding({ title: "Waived thing", severity: "MEDIUM" })] }) }),
    );
    expect(body).toContain("## Unresolved");
    expect(body).toContain("Accepted by the advisor");
    expect(body).toContain("Waived thing");
  });

  test("ready body without residue has no Unresolved section", () => {
    expect(buildFinishBody(baseCtx({ narrative: "Prose." }))).not.toContain("Unresolved");
  });

  test("Review section shows rounds and coverage percentages", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [committedRound({ phase: "review", sha: "abc1234def" })],
        coverage: { spec: 0.8, quality: null },
      }),
    );
    expect(body).toContain("## Review");
    expect(body).toContain("- Coverage: spec 80%, quality n/a");
    expect(body).toContain("### review attempt 1");
  });

  test("coverage alone renders the Review section", () => {
    const body = buildFinishBody(baseCtx({ coverage: { spec: 1, quality: 0.5 } }));
    expect(body).toContain("- Coverage: spec 100%, quality 50%");
  });

  test("a missing-verdict round says so", () => {
    const body = buildFinishBody(baseCtx({ rounds: [committedRound({ committed: false, outcome: "missing" })] }));
    expect(body).toContain("- _no verdict from this review_");
  });
});

describe("buildFinishBody — Unresolved with a repo template (A4)", () => {
  const template = "## Summary\n\n<!-- what -->\n\n## Testing\n\n- [ ] tests\n";
  const draftUnresolved = {
    reason: "1 open finding(s)",
    findings: [finding({ title: "Real bug" })],
    acceptance: "green" as const,
    gates: [],
    missing: [],
    unreviewed: [],
    accepted: [],
    ledger: [],
    stops: [],
    handoffs: [],
  };

  test.each(["merge", "strict"] as const)("%s mode renders Unresolved before the template sections", (mode) => {
    const body = buildFinishBody(
      baseCtx({ narrative: "Prose.", unresolved: draftUnresolved, template, templateMode: mode }),
    );
    expect(body.startsWith("## Unresolved")).toBe(true);
    expect(body.indexOf("## Unresolved")).toBeLessThan(body.indexOf("## Summary"));
    expect(body.match(/## Unresolved/g)).toHaveLength(1);
  });

  test("Unresolved stays after template frontmatter", () => {
    const body = buildFinishBody(
      baseCtx({
        narrative: "Prose.",
        unresolved: draftUnresolved,
        template: `---\nname: x\n---\n${template}`,
        templateMode: "merge",
      }),
    );
    expect(body.startsWith("---")).toBe(true);
    expect(body.indexOf("## Unresolved")).toBeLessThan(body.indexOf("## Summary"));
  });
});

describe("findings table, Set aside and Stops (finish A 7)", () => {
  const unresolvedBase = {
    reason: "r",
    findings: [],
    acceptance: "green" as const,
    gates: [],
    missing: [],
    unreviewed: [],
    accepted: [],
    ledger: [],
    stops: [],
    handoffs: [],
  };
  const e = (title: string, severity: Finding["severity"], state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
    id: title,
    finding: { severity, title, problem: "p", fix: "f", file: "src/x|y.ts" },
    state,
    ...(ref ? { ref } : {}),
  });
  const handoff = (over: Record<string, unknown> = {}) => ({
    n: 1,
    dir: "/o/finish-audit/feat/run-1.handoff-1",
    phase: "review" as const,
    limit: "fix" as const,
    baseSha: "s",
    headSha: "s",
    findingIds: ["a", "b", "c"],
    newUntracked: [],
    changedPaths: [],
    stoppedAt: "t",
    hasNote: true,
    patchSaved: true,
    restored: true,
    consumed: false,
    reapplied: false,
    untrackedRestored: [],
    untrackedMovedAside: ["big.md"],
    untrackedFailed: [],
    ...over,
  });

  test("one table sorted by state then severity; resolved rows collapsed", () => {
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          ledger: [
            e("fixed one", "HIGH", "fixed-unreviewed", "68e7c2189abc"),
            e("open low", "LOW", "open"),
            e("open high", "HIGH", "open"),
            e("waived one", "MEDIUM", "waived", "D-2"),
          ],
        },
      }),
    );
    const table = body.slice(body.indexOf("| Severity |"));
    expect(table.indexOf("open high")).toBeLessThan(table.indexOf("open low"));
    expect(table.indexOf("open low")).toBeLessThan(table.indexOf("fixed one"));
    expect(body).toContain("`68e7c21`");
    expect(body).toContain("src/x\\|y.ts");
    expect(body).toMatch(/<details>[\s\S]*waived one[\s\S]*D-2[\s\S]*<\/details>/);
  });

  test("states sort open, rejected, set-aside, unresolved, fixed-unreviewed, accepted", () => {
    const states: LedgerEntry["state"][] = [
      "accepted",
      "fixed-unreviewed",
      "unresolved",
      "set-aside",
      "rejected",
      "open",
    ];
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, ledger: states.map((s) => e(`t-${s}`, "HIGH", s)) } }),
    );
    const order = ["open", "rejected", "set-aside", "unresolved", "fixed-unreviewed", "accepted"].map((s) =>
      body.indexOf(`t-${s}`),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("LLM-sourced cell text cannot break the table or the details block", () => {
    const hostile: LedgerEntry = {
      id: "h",
      finding: { severity: "HIGH", title: "a </details> `x`\n| b", problem: "p", fix: "f", file: "f`<b>.ts" },
      state: "open",
    };
    const done: LedgerEntry = {
      ...hostile,
      id: "h2",
      finding: { ...hostile.finding, title: "z </details>" },
      state: "waived",
    };
    const body = buildFinishBody(baseCtx({ unresolved: { ...unresolvedBase, ledger: [hostile, done] } }));
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    const rows = body.split("\n").filter((l) => l.startsWith("| HIGH"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toMatch(/(?<!\\)`|<b>/);
  });

  test("lists set-aside handoffs and stops", () => {
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          stops: [{ kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 3 }],
          handoffs: [handoff()],
        },
      }),
    );
    expect(body).toContain("### Set aside");
    expect(body).toContain("run-1.handoff-1/changes.patch");
    expect(body).toContain("not re-applied");
    expect(body).toContain("moved into the handoff: big.md");
    expect(body).toContain("### Stops");
    expect(body).toContain("fix session stopped at the 20 min limit (3 findings, handoff-1)");
  });

  test("surfaces restore failures and user files that could not be put back", () => {
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          handoffs: [handoff({ restored: false, untrackedFailed: ["notes.md"], untrackedMovedAside: [] })],
        },
      }),
    );
    expect(body).toContain("worktree restore failed");
    expect(body).toContain("could not be put back: notes.md");
  });

  test("a re-applied and consumed handoff reads as committed", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, handoffs: [handoff({ consumed: true, reapplied: true })] } }),
    );
    expect(body).toContain("re-applied and committed");
  });

  test("pre-v3 results with an empty ledger keep the old open-findings list", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, findings: [finding({ title: "legacy" })] } }),
    );
    expect(body).toContain("### Open findings");
    expect(body).not.toContain("| Severity |");
  });

  test("a not-run gate renders as 'Gates did not run', never as a red gate named gates", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, gates: [{ name: "gates", status: "not-run" }] } }),
    );
    expect(body).toContain("Gates did not run");
    expect(body).not.toContain("Gate `gates` is red");
  });
});
