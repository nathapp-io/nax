/**
 * US-002 — deterministic finish PR title and body.
 *
 * The body is assembled by deterministic string joins over on-disk artifacts —
 * no model call. The renderer mirrors `escapeTableCell` so a `|` in a story
 * title cannot break its row, and mirrors `buildTitle` so finish-opened and
 * auto-PR-opened PRs read the same.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolveTitle } from "@flows/nax-finish/pr-title";
import { _prBodyDeps, buildFinishBody, buildFinishTitle, loadFinishPrContext } from "@flows/nax-finish/steps/pr-body";
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
    // narrative node never spoke reads the same as an auto-PR-opened one.
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

describe("buildFinishBody — Review rounds (US-002 AC8-AC12)", () => {
  test("renders one heading per round naming phase and attempt", () => {
    const body = buildFinishBody(
      baseCtx({
        rounds: [committedRound({ phase: "spec", attempt: 1 }), committedRound({ phase: "quality", attempt: 2 })],
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

  test("renders no Review rounds heading when rounds is empty", () => {
    const body = buildFinishBody(baseCtx({ rounds: [] }));
    expect(body).not.toContain("## Review rounds");
  });
});

// #1507: an empty finding list means four different things, and the body used
// to render all of them as "_no findings_" — which a human reads as "a reviewer
// looked and approved this". Only `passed` means that.
describe("buildFinishBody — what an empty round actually means", () => {
  const emptyRound = (over: Record<string, unknown>) => ({
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

describe("loadFinishPrContext — diffstat scope", () => {
  const origRun = _prBodyDeps.run;
  const origReadText = _prBodyDeps.readText;
  afterEach(() => {
    _prBodyDeps.run = origRun;
    _prBodyDeps.readText = origReadText;
  });

  const INPUT = { feature: "f", workdir: "/repo", branch: "feat/f", prdPath: "p.json", escalateTelegram: false };

  /** Capture every argv the loader issues, answering each `git diff` distinctly. */
  const captureRun = (stdoutFor: (cmd: string[]) => string = () => "") => {
    const calls: string[][] = [];
    _prBodyDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: stdoutFor(cmd), stderr: "" };
    };
    return calls;
  };

  test("excludes nax artifacts at any depth, not just the repo root", async () => {
    // The `**/` prefix and the `glob` magic word are both load-bearing: nax
    // writes to `.nax/` AND `<pkg>/.nax/`, and a root-anchored `:!.nax/**`
    // silently keeps the per-package copy — the largest file in the diff on
    // the run that motivated this.
    const calls = captureRun();
    _prBodyDeps.readText = async () => null;
    await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });

    const stat = calls.find((c) => c.includes("--stat"));
    expect(stat).toBeDefined();
    expect(stat).toContain(":(glob,exclude)**/.nax/**");
  });

  test("reports the excluded artifacts as a shortstat rather than dropping them", async () => {
    const calls = captureRun((cmd) =>
      cmd.includes("--shortstat") ? " 5 files changed, 1248 insertions(+)\n" : " a.ts | 1 +\n",
    );
    _prBodyDeps.readText = async () => null;
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });

    const short = calls.find((c) => c.includes("--shortstat"));
    expect(short).toContain(":(glob)**/.nax/**");
    expect(ctx.artifactSummary).toBe("5 files changed, 1248 insertions(+)");
    expect(ctx.diffstat).toBe(" a.ts | 1 +\n");
  });

  test("omits the artifact summary when the branch touched none", async () => {
    captureRun((cmd) => (cmd.includes("--shortstat") ? "" : " a.ts | 1 +\n"));
    _prBodyDeps.readText = async () => null;
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: [] });
    expect(ctx.artifactSummary).toBeUndefined();
  });

  test("issues no git diff at all when the base is unresolved", async () => {
    const calls = captureRun();
    _prBodyDeps.readText = async () => null;
    const ctx = await loadFinishPrContext(INPUT, { base: "", gatesRan: [] });
    expect(calls.filter((c) => c[1] === "diff")).toEqual([]);
    expect(ctx.diffstat).toBeUndefined();
    expect(ctx.artifactSummary).toBeUndefined();
  });

  test("survives a git failure without losing the rest of the context", async () => {
    _prBodyDeps.run = async () => {
      throw new Error("git exploded");
    };
    _prBodyDeps.readText = async () => null;
    const ctx = await loadFinishPrContext(INPUT, { base: "origin/main", gatesRan: ["lint"] });
    expect(ctx.diffstat).toBeUndefined();
    expect(ctx.artifactSummary).toBeUndefined();
    expect(ctx.gatesRan).toEqual(["lint"]);
  });
});
