# Finish B: Rulings Stick — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an advisor waive/supersede ruling binds every later finding on the same file (either lens, any round, same round), no fix undoes it, and a `fix` ruling never breaks an acceptance test by surprise.

**Architecture:** a pure ruling matcher (`finish/ruling-check.ts`) runs over every merged finding before and after the advisor judges a round; exact matches reuse the ruling, near matches (same anchor file, different title) become advisor questions carrying the prior ruling. Rulings are rendered into the quality-lens and fix prompts. Judgment questions get acceptance-test excerpts and a "fix + update ACs" option; review and gate fix sessions are guarded so only ruling-named acceptance tests may change.

**Tech Stack:** Bun 1.4, TypeScript strict, `bun:test`, Biome. Package: `packages/nax`.

**Spec:** `docs/superpowers/specs/2026-10-12-finish-b-rulings-stick-design.md` (read it before Task 1).

## Global Constraints

- All paths below are relative to `packages/nax/` unless they start with `docs/`.
- Bun-native APIs only (`Bun.file`, `Bun.write`); no `fs.readFileSync`, no `child_process`.
- Prompt text lives only in `src/prompts/builders/` (the advisor POLICY line goes in `src/prompts/builders/advisor-builder.ts`).
- No hardcoded test-framework syntax or test-file patterns: AC blocks are found by AC id (`AC-\d+`) only.
- Source files stay under 600 lines; test files under 800 (target 650). `review-loop.test.ts` is 643 lines: new review-loop tests go in a new `test/unit/finish/review-loop-rulings.test.ts`.
- Import from barrels in `src/` (`@/advisor`, `@/finish`, `@/prompts`); tests may import internals via `@/...`.
- Tests: iterate with `timeout 30 bun test <path> --timeout=5000`; never bare `bun test` with no path; never `bun run nax`.
- No `as unknown as`, no `@ts-` suppressions, no postfix `!` in tests (use `assertDefined`).
- Every `logger.*` call passes `{ storyId: "_run", ... }` with `storyId` first.
- Commits: conventional (`feat(finish):`, `test(finish):`), one task = one commit minimum, no attribution lines.
- Constants: `MAX_NEAR_MATCH_QUESTIONS = 6` (per round), acceptance evidence `MAX_PINNED_BLOCKS = 5`, `EXCERPT_LINES = 40`.
- Unchanged by ruling: trusted-decision model (`readTrustedDecisions`); a HIGH/CRITICAL finding or ruling is never reused without a new advisor call; acceptance-phase fix sessions are NOT guarded (A2-R1); AC supersede stays off while acceptance is enabled.
- Pre-push gate: from the repo root `bun run check:all` and `bun run typecheck`, and from `packages/nax` `bun run test:coverage`.

## Review Focus

1. **Two rulings on the same file, one waive and one supersede, and a third finding on that file.** Expected: one near question listing both ruling ids as evidence, newest first. Owned by Task 2 (matcher test "near collects every matching ruling, newest first").
2. **A ruling whose ledger line predates `anchorFile` and whose dedupe key ends in a `#hash`.** Expected: no anchor, so only a legacy-key exact match can hit it; a same-title finding on some file is NOT matched. Owned by Task 2.
3. **Advisor throws in the middle of reconcile.** Expected: every finding it was handling is carried unresolved, none is fixed, and the round still completes. Owned by Task 4 ("reconcile that throws carries its findings unresolved").
4. **A fix session that edits the acceptance file when the acceptance test path has spaces or does not exist at HEAD.** Expected: a path with spaces is restored correctly (literal pathspecs); a path absent at HEAD is left alone and recorded as not restorable (it counts in `reverted` only when restored). Owned by Task 9.
5. **An acceptance file with no AC ids at all** (hand-written tests). Expected: no evidence, no fix-and-update option, plain menu, no crash. Owned by Task 6.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/advisor/types.ts` (modify) | `anchorFile`, `rulingTitle` on question + decision; `acceptanceChanges` on decision; `updateAcs` on fix action + option fixed; `pinnedAcs` menu fact | 1, 7 |
| `src/advisor/service.ts` (modify) | `buildDraft` copies the new fields | 1, 7 |
| `src/finish/ruling-check.ts` (create) | pure: `Ruling`, `rulingFromDecision`, `rulingFromDropped`, `matchLevel`, `checkRulings`, `splitForRulings` | 2 |
| `src/finish/advise.ts` (modify) | question carries anchor/title; `adviseOn`, `collectJudgment`, `emptyJudged`, `concatJudged` exported; `FinishAdvisor` gains `rulingsInForce` + `reconcile` | 3 |
| `src/finish/advise-rulings.ts` (create) | `nearQuestion`, `reconcileRulings`, `loadRulings` | 3 |
| `src/finish/review-rulings.ts` (create) | `reconcileBefore`, `reconcileAfter` (the round steps 2 and 4) | 4 |
| `src/finish/review-loop.ts` (modify) | wires steps 2-4; passes `JudgeContext`; acceptance guard after review fix | 4, 8, 9 |
| `src/prompts/builders/finish-review-builder.ts` (modify) | quality-lens decisions; fix-prompt rulings + acceptance rule | 5 |
| `src/advisor/format.ts` (modify) | `formatRulingsForFix` | 5 |
| `src/operations/finish-{fix,branch-review}.ts` (modify) | new input fields | 5 |
| `src/finish/ops-impl.ts` (modify) | load rulings into fix + quality inputs | 5 |
| `src/finish/fix/dispositions.ts` (modify) | `ruling D-n` evidence | 5 |
| `src/finish/acceptance-evidence.ts` (create) | pure AC block split + scoring; `loadAcceptanceFiles` | 6 |
| `src/advisor/menus.ts` (modify) | fix-and-update option, labels, `toAction` | 7 |
| `src/prompts/builders/advisor-builder.ts` (modify) | one POLICY line | 7 |
| `src/finish/types.ts` (modify) | `Finding.allowedAcceptanceEdits` | 8 |
| `src/finish/machine.ts` (modify) | `acceptancePaths` into review deps | 8 |
| `src/finish/acceptance-guard.ts` (create) | detect, revert, diff AC blocks | 9 |
| `src/finish/state.ts` (modify) | `acceptanceGuard` | 9 |
| `src/finish/gates-loop.ts` (modify) | guard after gate fix | 9 |
| `src/finish/pr/body.ts`, `src/finish/pr/context.ts` (modify) | decision AC changes; guard lines | 10 |

---

### Task 1: Advisor carries the ruled finding's anchor and title

**Files:**
- Modify: `src/advisor/types.ts` (`AdviceQuestion`, `AdviceDecision`)
- Modify: `src/advisor/service.ts` (`buildDraft`, ~line 155)
- Test: `test/unit/advisor/service.test.ts`

**Interfaces:**
- Produces: `AdviceQuestion.anchorFile?: string`, `AdviceQuestion.rulingTitle?: string`, `AdviceDecision.anchorFile?: string`, `AdviceDecision.rulingTitle?: string`. `QuestionDraft` (= `Omit<AdviceQuestion, "id" | "askedAtSha">`) gains them automatically.

- [ ] **Step 1: Write the failing test** — append inside `describe("advisor service", ...)` in `test/unit/advisor/service.test.ts`:

```ts
  test("a judgment question's anchor file and title are copied onto the decision (finish B §3.2)", async () => {
    await withTempDir(async (dir) => {
      stubDeps(reply("B", { reason: "US-5 owns it" }));
      const out = await createAdvisor(actx(dir)).advise({ ...judgment, anchorFile: "src/a.ts", rulingTitle: "Race" });
      expect(out.decision?.anchorFile).toBe("src/a.ts");
      expect(out.decision?.rulingTitle).toBe("Race");
      const [line] = await readDecisions(dir, "feat");
      expect(line?.anchorFile).toBe("src/a.ts");
    });
  });
```

- [ ] **Step 2: Run it, expect FAIL** — `timeout 30 bun test test/unit/advisor/service.test.ts --timeout=5000` → type error / `undefined` for `anchorFile`.

- [ ] **Step 3: Implement.** In `src/advisor/types.ts` add to `AdviceQuestion` (after `findingSeverity`):

```ts
  /** Finish B §3.2: the ruled finding's `file`, copied onto the decision so later findings can match it. */
  anchorFile?: string;
  /** Finish B §3.2: the ruled finding's title, copied onto the decision. */
  rulingTitle?: string;
```

and to `AdviceDecision` (after `findingSeverity`):

```ts
  /** Finish B §3.2: copied from the question; absent on lines written before finish B. */
  anchorFile?: string;
  rulingTitle?: string;
```

In `src/advisor/service.ts` `buildDraft`, after the `dedupeKey` spread:

```ts
    ...(asked.question.anchorFile ? { anchorFile: asked.question.anchorFile } : {}),
    ...(asked.question.rulingTitle ? { rulingTitle: asked.question.rulingTitle } : {}),
```

- [ ] **Step 4: Run, expect PASS** — same command; also `timeout 30 bun test test/unit/advisor/ --timeout=5000`.

- [ ] **Step 5: Commit** — `git add src/advisor test/unit/advisor && git commit -m "feat(advisor): record the ruled finding's anchor file and title on decisions"`

---

### Task 2: Pure ruling matcher

**Files:**
- Create: `src/finish/ruling-check.ts`
- Modify: `src/finish/index.ts` (export the new symbols)
- Test: `test/unit/finish/ruling-check.test.ts`

**Interfaces:**
- Consumes: `AdviceDecision` (Task 1 fields), `dedupeKeyFor` (`@/advisor`), `MergedFindings`/`Contradiction` (`./merge-findings`), `Finding`.
- Produces:

```ts
export interface Ruling {
  id: string;                         // "D-n"
  action: "waive" | "supersede";
  anchor?: string;                    // repo-relative file
  title?: string;
  legacyKey?: string;                 // the decision's dedupeKey
  blocking: boolean;                  // ruled finding was HIGH/CRITICAL
  summary: string;                    // one line for prompts and evidence
  decision?: AdviceDecision;          // present for ledger rulings (needed by recordReuse)
}
export type MatchLevel = "exact" | "near" | "none";
export interface RulingCheck {
  reuse: { finding: Finding; ruling: Ruling }[];
  near: { finding: Finding; rulings: Ruling[] }[];
  rest: Finding[];
}
export function normTitle(title: string): string;
export function rulingFromDecision(d: AdviceDecision): Ruling | undefined;
export function rulingFromDropped(d: { finding: Finding; decisionId: string; action: "waive" | "supersede" }): Ruling;
export function matchLevel(f: Finding, r: Ruling): MatchLevel;
export function checkRulings(findings: Finding[], rulings: Ruling[]): RulingCheck;
export function splitForRulings(merged: MergedFindings, rulings: Ruling[]): { check: RulingCheck; merged: MergedFindings };
```

- [ ] **Step 1: Write the failing tests** — `test/unit/finish/ruling-check.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import type { Finding, MergedFindings } from "@/finish";
import { checkRulings, matchLevel, rulingFromDecision, rulingFromDropped, splitForRulings } from "@/finish";
import { assertDefined } from "@test/helpers";

const f = (over: Partial<Finding> = {}): Finding => ({
  severity: "MEDIUM",
  title: "Exec argv loses its config refusal",
  problem: "p",
  fix: "x",
  source: "quality",
  file: "nax-agent/src/tools/package-managers.ts",
  ...over,
});

const waive = (over: Parameters<typeof makeAdviceDecision>[0] = {}) =>
  makeAdviceDecision({
    id: "D-1",
    kind: "finish-judgment",
    action: { type: "waive", reason: "PRD outOfScope names it" },
    dedupeKey: "quality|Exec argv loses its config refusal|nax-agent/src/tools/package-managers.ts",
    findingSeverity: "MEDIUM",
    ...over,
  });

describe("rulingFromDecision", () => {
  test("reads anchor and title from the decision fields first", () => {
    const r = assertDefined(rulingFromDecision(waive({ anchorFile: "a.ts", rulingTitle: "T" })), "ruling");
    expect(r).toMatchObject({ id: "D-1", action: "waive", anchor: "a.ts", title: "T", blocking: false });
    expect(r.summary).toBe("waive: T (a.ts) — PRD outOfScope names it");
    expect(r.decision?.id).toBe("D-1");
  });

  test("legacy line: anchor and title recovered from the dedupe key", () => {
    const r = assertDefined(rulingFromDecision(waive()), "ruling");
    expect(r.anchor).toBe("nax-agent/src/tools/package-managers.ts");
    expect(r.title).toBe("Exec argv loses its config refusal");
  });

  test("legacy line ending in a #hash has no anchor (Review Focus 2)", () => {
    const r = assertDefined(rulingFromDecision(waive({ dedupeKey: "spec|Generic|#abc123def456" })), "ruling");
    expect(r.anchor).toBeUndefined();
    expect(matchLevel(f({ title: "Generic" }), r)).toBe("none");
  });

  test("a title containing | splits on the first and last separator", () => {
    const r = assertDefined(rulingFromDecision(waive({ dedupeKey: "quality|a | b|src/x.ts" })), "ruling");
    expect(r.title).toBe("a | b");
    expect(r.anchor).toBe("src/x.ts");
  });

  test("only finish-judgment waive / supersede decisions are rulings", () => {
    expect(rulingFromDecision(waive({ action: { type: "fix", instruction: "i" } }))).toBeUndefined();
    expect(rulingFromDecision(waive({ kind: "fix-cycle-give-up" }))).toBeUndefined();
  });

  test("a HIGH ruling is blocking", () => {
    expect(rulingFromDecision(waive({ findingSeverity: "HIGH" }))?.blocking).toBe(true);
  });
});

describe("matchLevel", () => {
  const r = assertDefined(rulingFromDecision(waive()), "ruling");
  test("#2464: a re-titled finding on the same file is near, from either lens", () => {
    const retitled = f({ title: "Opening configRefusal also unscreens Exec/install argv paths" });
    expect(matchLevel(retitled, r)).toBe("near");
    expect(matchLevel({ ...retitled, source: "spec" }, r)).toBe("near");
  });
  test("same file and same normalised title is exact, whatever the lens", () => {
    expect(matchLevel(f({ title: "exec ARGV loses its  config refusal." , source: "spec" }), r)).toBe("exact");
  });
  test("a different file is none; a finding without a file is none", () => {
    expect(matchLevel(f({ file: "other.ts" }), r)).toBe("none");
    expect(matchLevel(f({ file: undefined, problem: "no path here" }), r)).toBe("none");
  });
  test("legacy key equality is exact even without an anchor", () => {
    const hashKeyed = assertDefined(rulingFromDecision(waive({ dedupeKey: "quality|Generic|#000000000000" })), "r");
    const legacy = { ...hashKeyed, legacyKey: "quality|Generic|src/z.ts" };
    expect(matchLevel(f({ title: "Generic", file: undefined, problem: "see src/z.ts:3" }), legacy)).toBe("exact");
  });
});

describe("checkRulings", () => {
  test("exact non-blocking match is reused; near is asked; no match is rest", () => {
    const r = assertDefined(rulingFromDecision(waive()), "ruling");
    const exact = f({ source: "spec" });
    const near = f({ title: "Other wording" });
    const free = f({ file: "free.ts" });
    const out = checkRulings([exact, near, free], [r]);
    expect(out.reuse).toEqual([{ finding: exact, ruling: r }]);
    expect(out.near).toEqual([{ finding: near, rulings: [r] }]);
    expect(out.rest).toEqual([free]);
  });

  test("a blocking finding or ruling is never reused: it becomes near", () => {
    const r = assertDefined(rulingFromDecision(waive()), "ruling");
    expect(checkRulings([f({ severity: "HIGH" })], [r]).near).toHaveLength(1);
    const blocking = { ...r, blocking: true };
    expect(checkRulings([f()], [blocking]).near).toHaveLength(1);
  });

  test("near collects every matching ruling, newest first (Review Focus 1)", () => {
    const d1 = assertDefined(rulingFromDecision(waive({ id: "D-1" })), "d1");
    const d2 = assertDefined(
      rulingFromDecision(
        waive({ id: "D-2", action: { type: "supersede", target: { kind: "spec", section: "4" }, newText: "n" } }),
      ),
      "d2",
    );
    const out = checkRulings([f({ title: "Third finding" })], [d1, d2]);
    expect(out.near[0]?.rulings.map((x) => x.id)).toEqual(["D-2", "D-1"]);
  });
});

describe("rulingFromDropped", () => {
  test("a same-round waive binds by the finding's file and title", () => {
    const finding = f({ title: "ThreadJobRun has two lifetimes", source: "spec", file: "src/thread-job-run.ts" });
    const r = rulingFromDropped({ finding, decisionId: "D-2", action: "waive" });
    expect(r).toMatchObject({ id: "D-2", action: "waive", anchor: "src/thread-job-run.ts", blocking: false });
    expect(r.decision).toBeUndefined();
  });
});

describe("splitForRulings", () => {
  test("no rulings: merged is returned unchanged", () => {
    const merged: MergedFindings = { toFix: [f()], judged: [], contradictions: [] };
    expect(splitForRulings(merged, []).merged).toBe(merged);
  });

  test("a contradiction with a ruled side is dissolved; the free side goes to toFix", () => {
    const r = assertDefined(rulingFromDecision(waive()), "ruling");
    const spec = f({ source: "spec", title: "Spec side", file: "nax-agent/src/tools/package-managers.ts" });
    const quality = f({ source: "quality", title: "Quality side", file: "nax-agent/src/tools/package-managers.ts" });
    // both sides near-match the same-file ruling, so both are handled through the check
    const out = splitForRulings({ toFix: [], judged: [], contradictions: [{ spec, quality }] }, [r]);
    expect(out.merged.contradictions).toEqual([]);
    expect(out.check.near.map((n) => n.finding)).toEqual([spec, quality]);
    expect(out.merged.toFix).toEqual([]);
  });

  test("only matched findings leave toFix and judged", () => {
    const r = assertDefined(rulingFromDecision(waive()), "ruling");
    const matched = f({ title: "Other wording" });
    const free = f({ file: "free.ts" });
    const judgedFree = f({ file: "j.ts", judgment: true });
    const out = splitForRulings({ toFix: [matched, free], judged: [judgedFree], contradictions: [] }, [r]);
    expect(out.merged.toFix).toEqual([free]);
    expect(out.merged.judged).toEqual([judgedFree]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `timeout 30 bun test test/unit/finish/ruling-check.test.ts --timeout=5000` → import errors.

- [ ] **Step 3: Implement** `src/finish/ruling-check.ts`:

```ts
/**
 * Finish B §3: does a review finding repeat an advisor ruling? Pure.
 *
 * A ruling binds by the finding's anchor file, across both lenses. The title only
 * decides exact (reuse, no call) versus near (ask the advisor, with the ruling as
 * evidence). A HIGH/CRITICAL finding or ruling is never reused without a call.
 */
import type { AdviceDecision } from "@/advisor";
import { dedupeKeyFor } from "@/advisor";
import type { MergedFindings } from "./merge-findings";
import type { Finding } from "./types";

export interface Ruling {
  id: string;
  action: "waive" | "supersede";
  anchor?: string;
  title?: string;
  legacyKey?: string;
  blocking: boolean;
  summary: string;
  decision?: AdviceDecision;
}

export type MatchLevel = "exact" | "near" | "none";

export interface RulingCheck {
  reuse: { finding: Finding; ruling: Ruling }[];
  near: { finding: Finding; rulings: Ruling[] }[];
  rest: Finding[];
}

const BLOCKING = new Set(["HIGH", "CRITICAL", "error", "critical"]);

export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?:;,]+$/, "");
}

/** `phase|title|path-or-#hash`; a title may contain "|", so split on the first and last separator. */
function keyParts(key: string): { title?: string; anchor?: string } {
  const first = key.indexOf("|");
  const last = key.lastIndexOf("|");
  if (first < 0 || last <= first) return {};
  const tail = key.slice(last + 1);
  return { title: key.slice(first + 1, last), ...(tail !== "" && !tail.startsWith("#") ? { anchor: tail } : {}) };
}

function summaryOf(action: string, title: string | undefined, anchor: string | undefined, detail?: string): string {
  const head = `${action}: ${title ?? "finding"}${anchor ? ` (${anchor})` : ""}`;
  return detail ? `${head} — ${detail}` : head;
}

export function rulingFromDecision(d: AdviceDecision): Ruling | undefined {
  if (d.kind !== "finish-judgment") return undefined;
  const a = d.action;
  if (a.type !== "waive" && a.type !== "supersede") return undefined;
  const parts = d.dedupeKey ? keyParts(d.dedupeKey) : {};
  const anchor = d.anchorFile ?? parts.anchor;
  const title = d.rulingTitle ?? parts.title;
  return {
    id: d.id,
    action: a.type,
    ...(anchor ? { anchor } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(d.dedupeKey ? { legacyKey: d.dedupeKey } : {}),
    blocking: BLOCKING.has(d.findingSeverity ?? ""),
    summary: summaryOf(a.type, title, anchor, a.type === "waive" ? a.reason : a.newText),
    decision: d,
  };
}

export function rulingFromDropped(d: { finding: Finding; decisionId: string; action: "waive" | "supersede" }): Ruling {
  const { finding } = d;
  return {
    id: d.decisionId,
    action: d.action,
    ...(finding.file ? { anchor: finding.file } : {}),
    title: finding.title,
    blocking: BLOCKING.has(finding.severity),
    summary: summaryOf(d.action, finding.title, finding.file),
  };
}

export function matchLevel(f: Finding, r: Ruling): MatchLevel {
  if (r.legacyKey !== undefined && dedupeKeyFor(f.source ?? "quality", f) === r.legacyKey) return "exact";
  if (!f.file || !r.anchor || f.file !== r.anchor) return "none";
  return r.title !== undefined && normTitle(r.title) === normTitle(f.title) ? "exact" : "near";
}

export function checkRulings(findings: Finding[], rulings: Ruling[]): RulingCheck {
  const newestFirst = [...rulings].reverse();
  const reuse: RulingCheck["reuse"] = [];
  const near: RulingCheck["near"] = [];
  const rest: Finding[] = [];
  for (const f of findings) {
    const exact = newestFirst.find((r) => matchLevel(f, r) === "exact");
    if (exact && !exact.blocking && !BLOCKING.has(f.severity)) {
      reuse.push({ finding: f, ruling: exact });
      continue;
    }
    const matching = newestFirst.filter((r) => matchLevel(f, r) !== "none");
    if (matching.length > 0) near.push({ finding: f, rulings: matching });
    else rest.push(f);
  }
  return { reuse, near, rest };
}

/** §3.4 step 2: every merged finding through the check; a contradiction with a matched side is dissolved. */
export function splitForRulings(
  merged: MergedFindings,
  rulings: Ruling[],
): { check: RulingCheck; merged: MergedFindings } {
  if (rulings.length === 0) return { check: { reuse: [], near: [], rest: [] }, merged };
  const sides = merged.contradictions.flatMap((c) => [c.spec, c.quality]);
  const check = checkRulings([...merged.toFix, ...merged.judged, ...sides], rulings);
  const free = new Set(check.rest);
  const kept = merged.contradictions.filter((c) => free.has(c.spec) && free.has(c.quality));
  const keptSides = new Set(kept.flatMap((c) => [c.spec, c.quality]));
  const loose = sides.filter((f) => free.has(f) && !keptSides.has(f));
  return {
    check,
    merged: {
      toFix: [...merged.toFix.filter((f) => free.has(f)), ...loose.filter((f) => !f.judgment)],
      judged: [...merged.judged.filter((f) => free.has(f)), ...loose.filter((f) => f.judgment)],
      contradictions: kept,
    },
  };
}
```

Add to `src/finish/index.ts`:

```ts
export {
  checkRulings,
  matchLevel,
  normTitle,
  type Ruling,
  type RulingCheck,
  rulingFromDecision,
  rulingFromDropped,
  splitForRulings,
} from "./ruling-check";
```

(Check `src/finish/index.ts` exports `MergedFindings`; if not, add `export type { MergedFindings } from "./merge-findings";`.)

- [ ] **Step 4: Run, expect PASS** — same command, then `bun run check:import-cycles` from `packages/nax` (the new `@/advisor` import must not create a cycle; `advise.ts` already imports `@/advisor`, so it should not).

- [ ] **Step 5: Commit** — `git add src/finish/ruling-check.ts src/finish/index.ts test/unit/finish/ruling-check.test.ts && git commit -m "feat(finish): pure ruling matcher keyed on the anchor file"`

---

### Task 3: Finish advisor reconciles findings against rulings

**Files:**
- Modify: `src/finish/advise.ts`
- Create: `src/finish/advise-rulings.ts`
- Modify: `src/finish/index.ts` (export `emptyJudged`, `concatJudged`, `JudgeContext`, `MAX_NEAR_MATCH_QUESTIONS`)
- Test: `test/unit/finish/advise-rulings.test.ts`

**Interfaces:**
- Consumes: Task 2 (`Ruling`, `RulingCheck`, `rulingFromDecision`).
- Produces (in `advise.ts`):

```ts
/** Finish B: what a judgment question may carry beyond the finding (acceptance evidence arrives in Task 8). */
export interface JudgeContext {
  acceptance?: import("./acceptance-evidence").AcceptanceFile[];   // added in Task 8; leave the field out until then
}
export function emptyJudged(): JudgedResult;
export function concatJudged(...results: JudgedResult[]): JudgedResult;
export interface FinishAdvisor {
  // existing members unchanged, plus:
  rulingsInForce(): Promise<Ruling[]>;
  reconcile(check: RulingCheck, budget: number): Promise<{ result: JudgedResult; asked: number }>;
}
```

- In `advise-rulings.ts`: `export const MAX_NEAR_MATCH_QUESTIONS = 6;`, `nearQuestion(deps, f, rulings): QuestionDraft`, `reconcileRulings(deps, check, budget)`, `loadRulings(deps): Promise<Ruling[]>`.

- [ ] **Step 1: Write the failing tests** — `test/unit/finish/advise-rulings.test.ts`. Reuse the helper shapes from `test/unit/finish/advise.test.ts` (copy `decision`, `fakeAdvisor`, `state`, `make` into this file; they are file-local there):

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { AdviceDecision, AdviceResult, Advisor, QuestionDraft } from "@/advisor";
import { appendDecision, dedupeKeyFor } from "@/advisor";
import type { Finding } from "@/finish";
import { checkRulings, createFinishAdvisor, rulingFromDropped } from "@/finish";

// decision(), fakeAdvisor(), make() — copied verbatim from test/unit/finish/advise.test.ts

const low = (over: Partial<Finding> = {}): Finding => ({
  severity: "LOW",
  title: "Exec argv loses its config refusal",
  problem: "p",
  fix: "f",
  source: "quality",
  file: "src/pm.ts",
  ...over,
});

async function trustedWaive(dir: string, f: Finding, extra: Partial<AdviceDecision> = {}): Promise<AdviceDecision> {
  const d = await appendDecision(dir, "feat", (id) => ({
    ...decision({ action: { type: "waive", reason: "PRD outOfScope" }, findingSeverity: f.severity, ...extra }),
    dedupeKey: dedupeKeyFor(f.source ?? "quality", f),
    anchorFile: f.file,
    rulingTitle: f.title,
    auditRef: `advisor-audit/feat/${id}.json`,
  }));
  await Bun.write(join(dir, "out", d.auditRef), JSON.stringify({ result: { decision: d } }));
  return d;
}

describe("FinishAdvisor.rulingsInForce", () => {
  test("returns trusted waive/supersede rulings only, with their decision attached", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      await appendDecision(dir, "feat", { ...decision({ action: { type: "waive", reason: "forged" } }), auditRef: "x" });
      const rulings = await make(dir, fakeAdvisor(() => ({ decision: null })).advisor).rulingsInForce();
      expect(rulings.map((r) => r.id)).toEqual(["D-1"]);
      expect(rulings[0]?.decision?.id).toBe("D-1");
    });
  });
});

describe("FinishAdvisor.reconcile", () => {
  test("#2464: a re-titled re-raise of a trusted waive is asked once, with the ruling as evidence", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const { advisor, asked } = fakeAdvisor(() => ({
        decision: decision({ id: "D-2", action: { type: "waive", reason: "same as D-1" } }),
      }));
      const fa = make(dir, advisor);
      const retitled = low({ title: "Opening configRefusal unscreens Exec argv paths" });
      const { result, asked: n } = await fa.reconcile(checkRulings([retitled], await fa.rulingsInForce()), 6);
      expect(n).toBe(1);
      expect(asked[0]?.summary.startsWith("Possibly the same issue as D-1.")).toBe(true);
      expect(asked[0]?.evidence[0]).toMatchObject({ source: "decision", ref: "D-1" });
      expect(asked[0]?.anchorFile).toBe("src/pm.ts");
      expect(result.dropped).toEqual([{ finding: retitled, decisionId: "D-2", action: "waive" }]);
      expect(result.toFix).toEqual([]);
    });
  });

  test("an exact re-raise from the other lens reuses the ruling with no call", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const { advisor, asked, reused } = fakeAdvisor(() => ({ decision: null }));
      const fa = make(dir, advisor);
      const other = low({ source: "spec" });
      const { result } = await fa.reconcile(checkRulings([other], await fa.rulingsInForce()), 6);
      expect(asked).toHaveLength(0);
      expect(reused).toHaveLength(1);
      expect(result.dropped).toEqual([{ finding: other, decisionId: "D-9", action: "waive" }]);
    });
  });

  test("a same-round ruling (no decision object) is reused without a ledger line", async () => {
    await withTempDir(async (dir) => {
      const { advisor, reused } = fakeAdvisor(() => ({ decision: null }));
      const ruled = low({ source: "spec" });
      const r = rulingFromDropped({ finding: ruled, decisionId: "D-2", action: "waive" });
      const { result } = await make(dir, advisor).reconcile(checkRulings([low()], [r]), 6);
      expect(reused).toHaveLength(0);
      expect(result.dropped[0]).toMatchObject({ decisionId: "D-2", action: "waive" });
    });
  });

  test("near matches past the budget are carried unresolved, never fixed", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const { advisor, asked } = fakeAdvisor(() => ({ decision: decision({ action: { type: "fix", instruction: "i" } }) }));
      const fa = make(dir, advisor);
      const a = low({ title: "A" });
      const b = low({ title: "B" });
      const { result, asked: n } = await fa.reconcile(checkRulings([a, b], await fa.rulingsInForce()), 1);
      expect(n).toBe(1);
      expect(asked).toHaveLength(1);
      expect(result.unresolved).toEqual([b]);
      expect(result.toFix.map((f) => f.title)).toEqual(["A"]);
    });
  });

  test("advisor gives no decision on a near match: unresolved", async () => {
    await withTempDir(async (dir) => {
      await trustedWaive(dir, low());
      const fa = make(dir, fakeAdvisor(() => ({ decision: null, fallbackReason: "down" })).advisor);
      const near = low({ title: "Other" });
      const { result } = await fa.reconcile(checkRulings([near], await fa.rulingsInForce()), 6);
      expect(result.unresolved).toEqual([near]);
    });
  });
});

describe("judgment questions carry the anchor (finish B §3.2)", () => {
  test("judged() sends anchorFile and rulingTitle", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: null }));
      await make(dir, advisor).judged([low({ judgment: true })], [], state(dir));
      expect(asked[0]?.anchorFile).toBe("src/pm.ts");
      expect(asked[0]?.rulingTitle).toBe("Exec argv loses its config refusal");
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `timeout 30 bun test test/unit/finish/advise-rulings.test.ts --timeout=5000`.

- [ ] **Step 3: Implement.**

In `src/finish/advise.ts`:

1. `judgmentQuestion` adds the anchor after `dedupeKey`:

```ts
    ...(f.file ? { anchorFile: f.file } : {}),
    rulingTitle: f.title,
```

and is exported (`export function judgmentQuestion`). Do the same `anchorFile`/`rulingTitle` spread in `contradictionQuestion` using `c.spec`.

2. Split `judgeOne` so its post-reuse half is reusable. Export the result type and the helper:

```ts
export type JudgeOneResult = { keep?: Finding; ref?: AdviceRef; hold?: string; fallback?: string; dropped?: Dropped };

/** Ask one question about `f` and turn the decision into a judge result (no reuse lookup). */
export async function adviseOn(deps: FinishAdvisorDeps, question: QuestionDraft, f: Finding): Promise<JudgeOneResult> {
  const { decision, fallbackReason } = await deps.advisor.advise(question, { findingSeverity: f.severity });
  if (!decision) return { fallback: fallbackReason ?? "advisor unavailable" };
  const ref: AdviceRef = { decisionId: decision.id, optionId: decision.chosenOptionId, reused: false };
  const { action } = decision;
  if (action.type === "hold") return { ref, hold: decision.rationale };
  if (action.type !== "fix") {
    const dropped = droppedBy(action.type);
    return dropped ? { ref, dropped } : { ref };
  }
  return { ref, keep: { ...f, fix: `${f.fix}\n\nAdvisor ruling (${decision.id}): ${action.instruction}` } };
}
```

`judgeOne` keeps its reuse block, then `return adviseOn(deps, question, f);`.

3. Export `collectJudgment` (unchanged body) and add:

```ts
export function emptyJudged(): JudgedResult {
  return { toFix: [], advice: [], unresolved: [], dropped: [], held: [] };
}

export function concatJudged(...results: JudgedResult[]): JudgedResult {
  return {
    toFix: results.flatMap((r) => r.toFix),
    advice: results.flatMap((r) => r.advice),
    unresolved: results.flatMap((r) => r.unresolved),
    dropped: results.flatMap((r) => r.dropped),
    held: results.flatMap((r) => r.held),
  };
}
```

and make `judged()` start from `emptyJudged()`.

4. `FinishAdvisor` gains the two members; `createFinishAdvisor` binds them:

```ts
    rulingsInForce: () => loadRulings(deps),
    reconcile: (check, budget) => reconcileRulings(deps, check, budget),
```

Create `src/finish/advise-rulings.ts`:

```ts
/**
 * Finish B §3.4-§3.6: findings that repeat a ruling. Exact matches reuse it with no call;
 * near matches are asked (up to `budget` per round) with the matched rulings as evidence;
 * whatever cannot be asked is carried unresolved. Nothing here ever adds to the fix list
 * except an explicit `fix` ruling.
 */
import type { QuestionDraft } from "@/advisor";
import { readTrustedDecisions } from "@/advisor";
import { adviseOn, collectJudgment, emptyJudged, type FinishAdvisorDeps, type JudgedResult, judgmentQuestion } from "./advise";
import { type Ruling, type RulingCheck, rulingFromDecision } from "./ruling-check";
import type { Finding } from "./types";

/** Near-match questions per review round (spec §3.6); separate from MAX_ADVISE_ROUNDS. */
export const MAX_NEAR_MATCH_QUESTIONS = 6;

export async function loadRulings(deps: FinishAdvisorDeps): Promise<Ruling[]> {
  const decisions = await readTrustedDecisions(deps.repoRoot, deps.feature, deps.outputDir).catch(() => []);
  return decisions.flatMap((d) => {
    const r = rulingFromDecision(d);
    return r ? [r] : [];
  });
}

export function nearQuestion(deps: FinishAdvisorDeps, f: Finding, rulings: Ruling[]): QuestionDraft {
  const base = judgmentQuestion(deps, f.source ?? "quality", f);
  const ids = rulings.map((r) => r.id).join(", ");
  return {
    ...base,
    summary: `Possibly the same issue as ${ids}. ${base.summary}`,
    evidence: [...rulings.map((r) => ({ source: "decision" as const, ref: r.id, text: r.summary })), ...base.evidence],
  };
}

async function reuseOne(deps: FinishAdvisorDeps, out: JudgedResult, f: Finding, r: Ruling): Promise<void> {
  const recorded = r.decision
    ? await deps.advisor.recordReuse(judgmentQuestion(deps, f.source ?? "quality", f), r.decision)
    : null;
  const decisionId = recorded?.id ?? r.id;
  out.advice.push({ decisionId, optionId: r.decision?.chosenOptionId ?? "", reused: true });
  out.dropped.push({ finding: f, decisionId, action: r.action });
}

export async function reconcileRulings(
  deps: FinishAdvisorDeps,
  check: RulingCheck,
  budget: number,
): Promise<{ result: JudgedResult; asked: number }> {
  const out = emptyJudged();
  for (const { finding, ruling } of check.reuse) await reuseOne(deps, out, finding, ruling);
  let asked = 0;
  for (const { finding, rulings } of check.near) {
    if (asked >= budget) {
      out.unresolved.push(finding);
      continue;
    }
    asked += 1;
    collectJudgment(out, finding, await adviseOn(deps, nearQuestion(deps, finding, rulings), finding));
  }
  return { result: out, asked };
}
```

`collectJudgment` already pushes `f` to `unresolved` on hold or fallback, and to `toFix` only on `keep` (a `fix` ruling).

Note: if `advise-rulings.ts` importing from `./advise` while `advise.ts` imports `./advise-rulings` creates a runtime cycle flagged by `bun run check:import-cycles`, move `loadRulings`/`nearQuestion`/`reconcileRulings` callers so that `createFinishAdvisor` receives them by injection instead: keep the binding in `advise.ts` as `rulingsInForce: () => _adviseRulings.load(deps)` where `_adviseRulings` is set by `advise-rulings.ts`… — simpler fix: put `emptyJudged`, `concatJudged`, `collectJudgment`, `adviseOn`, `judgmentQuestion` and the shared types in a new leaf `src/finish/advise-core.ts`, imported by both `advise.ts` and `advise-rulings.ts`. Do this split up front if the cycle check fails.

Export from `src/finish/index.ts`: `emptyJudged`, `concatJudged`, `MAX_NEAR_MATCH_QUESTIONS`, `type JudgeContext` (add `export interface JudgeContext {}` in `advise.ts` now as a placeholder type with a doc comment "Task 8 adds acceptance files"; biome may flag an empty interface — if so use `export type JudgeContext = { acceptance?: never };` and widen it in Task 8).

- [ ] **Step 4: Run, expect PASS** — `timeout 30 bun test test/unit/finish/advise-rulings.test.ts test/unit/finish/advise.test.ts --timeout=5000`; `bun run check:import-cycles`.

- [ ] **Step 5: Commit** — `git commit -am "feat(finish): reconcile findings against rulings in the finish advisor"` (add the new files first).

---

### Task 4: The review round checks rulings before and after judging

**Files:**
- Create: `src/finish/review-rulings.ts`
- Modify: `src/finish/review-loop.ts` (`runOneRound`)
- Test: `test/unit/finish/review-loop-rulings.test.ts`

**Interfaces:**
- Consumes: `FinishAdvisor.rulingsInForce/reconcile` (Task 3), `splitForRulings`, `checkRulings`, `rulingFromDropped` (Task 2), `emptyJudged`, `concatJudged`, `MAX_NEAR_MATCH_QUESTIONS`.
- Produces:

```ts
export async function reconcileBefore(
  deps: Pick<ReviewLoopDeps, "advise" | "assertNotAborted">,
  merged: MergedFindings,
): Promise<{ merged: MergedFindings; result: JudgedResult; asked: number }>;
export async function reconcileAfter(
  deps: Pick<ReviewLoopDeps, "advise" | "assertNotAborted">,
  toFix: Finding[],
  judged: JudgedResult,
  budget: number,
): Promise<{ rest: Finding[]; result: JudgedResult }>;
```

- [ ] **Step 1: Write the failing tests** — `test/unit/finish/review-loop-rulings.test.ts`. Use the real `createFinishAdvisor` over a fake `Advisor` so the loop and the advisor glue are exercised together:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FinishGitModel, installFinishGit, makeFinishOps, makeFinishState, withTempDir } from "@test/helpers";
import type { AdviceDecision, AdviceResult, Advisor, QuestionDraft } from "@/advisor";
import { appendDecision, dedupeKeyFor } from "@/advisor";
import type { Finding, FinishAdvisor, FinishOps, FinishReviewOutput, ReviewInputs } from "@/finish";
import { createFinishAdvisor, runReviewLoop } from "@/finish";

const inputs: ReviewInputs = { changed: ["a.ts"], hints: [], stories: [], prdPath: ".nax/features/feat/prd.json" };
let restoreGit: () => void = () => {};
afterEach(() => restoreGit());

// decision() and fakeAdvisor() — same shapes as test/unit/finish/advise.test.ts

function loopDeps(ops: FinishOps, auditDir: string, advise?: FinishAdvisor) {
  return {
    ops,
    ...(advise ? { advise } : {}),
    inputs,
    audit: { auditDir, runId: "run-1" },
    now: () => "t",
    assertNotAborted: () => {},
    fix: { ops, audit: { auditDir, runId: "run-1" }, now: () => "t" },
  };
}

function finishAdvisor(dir: string, advisor: Advisor): FinishAdvisor {
  return createFinishAdvisor({
    advisor,
    repoRoot: dir,
    outputDir: join(dir, "out"),
    feature: "feat",
    acceptanceEnabled: () => true,
    judgedEnabled: true,
    approvalEnabled: false,
    git: async () => ({ exitCode: 0 }),
  });
}

const seam = "src/thread-job-run.ts";
const specJudged: Finding = {
  severity: "MEDIUM", title: "ThreadJobRun has two lifetimes", problem: "p", fix: "f",
  source: "spec", file: seam, judgment: true,
};
const qualityPlain: Finding = {
  severity: "MEDIUM", title: "Constructor carries a test-only legacy mode", problem: "p", fix: "remove the seam",
  source: "quality", file: seam,
};
const out = (findings: Finding[]): FinishReviewOutput => ({ findings, covered: [seam] });

describe("review round: rulings stick (finish B)", () => {
  test("koda case: the other lens's plain sibling of a same-round waive is asked, not fixed", async () => {
    await withTempDir(async (dir) => {
      const git: FinishGitModel = { dirty: false, head: 1 };
      restoreGit = installFinishGit(git);
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { spec: [out([specJudged])], quality: [out([qualityPlain])] }, {
        fix: async (_p, req) => {
          seen.push(req.findings ?? []);
          git.dirty = true;
          return {};
        },
      });
      const { advisor, asked } = fakeAdvisor((q) =>
        q.summary.startsWith("Possibly the same issue as D-2")
          ? { decision: decision({ id: "D-3", action: { type: "waive", reason: "D-2 keeps the seam" } }) }
          : { decision: decision({ id: "D-2", action: { type: "waive", reason: "acceptance drives runs through it" } }) },
      );
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, finishAdvisor(dir, advisor)));
      expect(seen.flat().map((f) => f.title)).not.toContain(qualityPlain.title);
      expect(asked.map((q) => q.summary.slice(0, 32))).toEqual([
        expect.stringContaining("ThreadJobRun has two lifetimes"),
        "Possibly the same issue as D-2. ",
      ]);
      const entry = state.review.ledger.find((e) => e.finding.title === qualityPlain.title);
      expect(entry?.state).toBe("waived");
    });
  });

  test("koda case with the near budget spent or no decision: the sibling is unresolved, not fixed", async () => {
    await withTempDir(async (dir) => {
      const git: FinishGitModel = { dirty: false, head: 1 };
      restoreGit = installFinishGit(git);
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { spec: [out([specJudged])], quality: [out([qualityPlain])] }, {
        fix: async (_p, req) => {
          seen.push(req.findings ?? []);
          return {};
        },
      });
      const { advisor } = fakeAdvisor((q) =>
        q.summary.startsWith("Possibly")
          ? { decision: null, fallbackReason: "down" }
          : { decision: decision({ id: "D-2", action: { type: "waive", reason: "keep it" } }) },
      );
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, finishAdvisor(dir, advisor)));
      expect(seen.flat()).toEqual([]);
      expect(state.review.unresolved.map((f) => f.title)).toEqual([qualityPlain.title]);
    });
  });

  test("#2464 across rounds: a re-titled re-raise of a trusted waive never reaches the fixer", async () => {
    await withTempDir(async (dir) => {
      const git: FinishGitModel = { dirty: false, head: 1 };
      restoreGit = installFinishGit(git);
      const ruled: Finding = { ...qualityPlain, severity: "LOW", title: "Exec argv loses its refusal", file: "src/pm.ts" };
      const d = await appendDecision(dir, "feat", (id) => ({
        ...decision({ action: { type: "waive", reason: "outOfScope" }, findingSeverity: "LOW" }),
        dedupeKey: dedupeKeyFor("quality", ruled),
        anchorFile: "src/pm.ts",
        rulingTitle: ruled.title,
        auditRef: `advisor-audit/feat/${id}.json`,
      }));
      await Bun.write(join(dir, "out", d.auditRef), JSON.stringify({ result: { decision: d } }));
      const retitled: Finding = { ...ruled, title: "Opening configRefusal unscreens Exec argv" };
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { quality: [out([retitled])] }, {
        fix: async (_p, req) => {
          seen.push(req.findings ?? []);
          return {};
        },
      });
      const { advisor } = fakeAdvisor(() => ({ decision: decision({ id: "D-2", action: { type: "waive", reason: "D-1" } }) }));
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, finishAdvisor(dir, advisor)));
      expect(seen).toEqual([]);
      expect(state.review.ledger.find((e) => e.finding.title === retitled.title)?.state).toBe("waived");
    });
  });

  test("reconcile that throws carries its findings unresolved (Review Focus 3)", async () => {
    await withTempDir(async (dir) => {
      const git: FinishGitModel = { dirty: false, head: 1 };
      restoreGit = installFinishGit(git);
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { quality: [out([qualityPlain])] }, {
        fix: async (_p, req) => {
          seen.push(req.findings ?? []);
          return {};
        },
      });
      const base = finishAdvisor(dir, fakeAdvisor(() => ({ decision: null })).advisor);
      const advise: FinishAdvisor = {
        ...base,
        rulingsInForce: async () => [
          { id: "D-1", action: "waive", anchor: seam, title: "x", blocking: false, summary: "waive: x" },
        ],
        reconcile: async () => {
          throw new Error("boom");
        },
      };
      const state = makeFinishState({ workdir: dir });
      await runReviewLoop(state, loopDeps(ops, dir, advise));
      expect(seen).toEqual([]);
      expect(state.review.unresolved.map((f) => f.title)).toEqual([qualityPlain.title]);
      expect(state.review.rounds).toBe(1);
    });
  });

  test("advisor off: findings flow exactly as before (no rulings consulted)", async () => {
    await withTempDir(async (dir) => {
      const git: FinishGitModel = { dirty: false, head: 1 };
      restoreGit = installFinishGit(git);
      const seen: Finding[][] = [];
      const ops = makeFinishOps([], { quality: [out([qualityPlain])] }, {
        fix: async (_p, req) => {
          seen.push(req.findings ?? []);
          git.dirty = true;
          return {};
        },
      });
      await runReviewLoop(makeFinishState({ workdir: dir }), loopDeps(ops, dir));
      expect(seen[0]?.map((f) => f.title)).toEqual([qualityPlain.title]);
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `timeout 30 bun test test/unit/finish/review-loop-rulings.test.ts --timeout=5000`.

- [ ] **Step 3: Implement** `src/finish/review-rulings.ts`:

```ts
/**
 * Finish B §3.4: the review round's ruling checks. Step 2 runs every merged finding
 * against the rulings already in force; step 4 runs the plain findings still headed for
 * the fixer against the rulings the advisor made in step 3 (the same-round cross-lens case).
 * Any failure carries the findings it was handling unresolved: never fixed against a ruling.
 */
import { getSafeLogger } from "@/logger";
import { concatJudged, emptyJudged, type FinishAdvisor, type JudgedResult } from "./advise";
import { MAX_NEAR_MATCH_QUESTIONS } from "./advise-rulings";
import type { MergedFindings } from "./merge-findings";
import { checkRulings, type RulingCheck, rulingFromDropped, splitForRulings } from "./ruling-check";
import type { Finding } from "./types";

interface Deps {
  advise?: FinishAdvisor;
  assertNotAborted: () => void;
}

async function safeReconcile(
  deps: Deps,
  advisor: FinishAdvisor,
  check: RulingCheck,
  budget: number,
): Promise<{ result: JudgedResult; asked: number }> {
  if (check.reuse.length === 0 && check.near.length === 0) return { result: emptyJudged(), asked: 0 };
  try {
    return await advisor.reconcile(check, budget);
  } catch (err) {
    deps.assertNotAborted();
    getSafeLogger()?.warn("finish", "Ruling reconcile failed; carrying the matched findings unresolved", {
      storyId: "_run",
      error: String(err),
    });
    const unresolved = [...check.reuse.map((r) => r.finding), ...check.near.map((n) => n.finding)];
    return { result: { ...emptyJudged(), unresolved }, asked: 0 };
  }
}

export async function reconcileBefore(
  deps: Deps,
  merged: MergedFindings,
): Promise<{ merged: MergedFindings; result: JudgedResult; asked: number }> {
  const advisor = deps.advise;
  if (!advisor?.judgedEnabled) return { merged, result: emptyJudged(), asked: 0 };
  const rulings = await advisor.rulingsInForce().catch(() => []);
  const split = splitForRulings(merged, rulings);
  const r = await safeReconcile(deps, advisor, split.check, MAX_NEAR_MATCH_QUESTIONS);
  return { merged: split.merged, ...r };
}

export async function reconcileAfter(
  deps: Deps,
  toFix: Finding[],
  judged: JudgedResult,
  budget: number,
): Promise<{ rest: Finding[]; result: JudgedResult }> {
  const advisor = deps.advise;
  if (!advisor?.judgedEnabled || judged.dropped.length === 0) return { rest: toFix, result: emptyJudged() };
  const check = checkRulings(toFix, judged.dropped.map(rulingFromDropped));
  const r = await safeReconcile(deps, advisor, check, Math.max(0, budget));
  return { rest: check.rest, result: r.result };
}

export { concatJudged };
```

In `src/finish/review-loop.ts` `runOneRound`, replace the block from `const judged = await judgeRound(state, deps, merged);` through `const fixList = ...` with:

```ts
  const before = await reconcileBefore(deps, merged);
  const judgedNow = await judgeRound(state, deps, before.merged);
  const after = await reconcileAfter(deps, before.merged.toFix, judgedNow, MAX_NEAR_MATCH_QUESTIONS - before.asked);
  const judged = concatJudged(before.result, judgedNow, after.result);
  if (round.missing.length === 0) ledgerEvent(state, { kind: "full-round", raised, round: state.review.rounds + 1 });
  recordJudgment(state, judged);
  const fixList = specFirst([...after.rest, ...judged.toFix]);
```

(Remove the old standalone `full-round` / `recordJudgment` lines this replaces; keep their order: full-round before recordJudgment, as today.) Imports: `concatJudged`, `MAX_NEAR_MATCH_QUESTIONS` from `./advise` / `./advise-rulings`, `reconcileBefore`, `reconcileAfter` from `./review-rulings`.

Why `ruled` events land correctly: `recordJudgment` already writes `ruled → waived|superseded` for every `dropped` entry and `ruled → unresolved` for every `unresolved` one, so reused and near-ruled findings get their ledger state with no new event kinds.

- [ ] **Step 4: Run, expect PASS** — `timeout 30 bun test test/unit/finish/review-loop-rulings.test.ts test/unit/finish/review-loop.test.ts test/unit/finish/machine-advise.test.ts --timeout=5000`. Existing review-loop tests must stay green unchanged (a `FinishAdvisor` fake there that lacks `rulingsInForce`/`reconcile` will fail to typecheck: add `rulingsInForce: async () => []` and `reconcile: async () => ({ result: emptyJudged(), asked: 0 })` to those fakes, nothing else).

- [ ] **Step 5: Commit** — `git commit -m "feat(finish): check every finding against rulings before and after judging a round"`

---

### Task 5: Rulings reach the quality lens and every fix session

**Files:**
- Modify: `src/advisor/format.ts` (add `formatRulingsForFix`), `src/advisor/index.ts` (export it)
- Modify: `src/prompts/builders/finish-review-builder.ts`
- Modify: `src/operations/finish-branch-review.ts`, `src/operations/finish-fix.ts`
- Modify: `src/finish/ops-impl.ts`, `src/finish/fix/dispositions.ts`
- Test: `test/unit/prompts/builders/finish-review-builder.test.ts`, `test/unit/advisor/format.test.ts`, `test/unit/finish/fix/dispositions.test.ts`, `test/unit/finish/ops-impl-a4.test.ts`

**Interfaces:**
- Produces: `formatRulingsForFix(decisions: readonly AdviceDecision[]): { text: string; ids: string[] }`; `FinishBranchReviewPromptInput.decisions?: string`; `buildFinishFixPrompt(phase, { …, rulings?: string, acceptancePaths?: string[] })`; `FinishFixInput.rulings?: string`, `FinishFixInput.rulingIds?: string[]`, `FinishFixInput.acceptancePaths?: string[]`; `validateDispositions(workdir, dispositions, rulingIds: readonly string[] = [])`; `FixRequest.acceptancePaths?: string[]`.

- [ ] **Step 1: Write the failing tests.**

`test/unit/advisor/format.test.ts`:

```ts
describe("formatRulingsForFix", () => {
  test("lists prompt-safe waives and supersedes with a do-not-undo line; skips blocking waives", () => {
    const out = formatRulingsForFix([
      makeAdviceDecision({ id: "D-2", action: { type: "waive", reason: "acceptance drives it" }, dedupeKey: "spec|Seam|src/t.ts", findingSeverity: "MEDIUM" }),
      makeAdviceDecision({ id: "D-3", action: { type: "waive", reason: "x" }, dedupeKey: "spec|Big|src/b.ts", findingSeverity: "HIGH" }),
      makeAdviceDecision({ id: "D-5", action: { type: "supersede", target: { kind: "spec", section: "4.2" }, newText: "new" } }),
      makeAdviceDecision({ id: "D-6", action: { type: "fix", instruction: "i" } }),
    ]);
    expect(out.ids).toEqual(["D-2", "D-5"]);
    expect(out.text).toContain("- D-2 waived: Seam (src/t.ts) — acceptance drives it");
    expect(out.text).toContain("- D-5 superseded spec § 4.2: new");
    expect(out.text).not.toContain("D-3");
  });
  test("empty when nothing applies", () => {
    expect(formatRulingsForFix([])).toEqual({ text: "", ids: [] });
  });
});
```

`test/unit/prompts/builders/finish-review-builder.test.ts`:

```ts
  test("branch prompt renders settled decisions (finish B §4.1)", () => {
    const p = buildFinishBranchReviewPrompt({ base: "origin/main", stories: [], changedFiles: [], hints: [], decisions: "- D-2 waived: Seam" });
    expect(p).toContain("## Decisions already made (do not raise these again)\n- D-2 waived: Seam");
  });

  test("every fix phase renders rulings in force; review adds the ruling rejection rule", () => {
    for (const phase of ["acceptance", "gate", "review"] as const) {
      const p = buildFinishFixPrompt(phase, { findings: [], rulings: "- D-2 waived: Seam" });
      expect(p).toContain("## Rulings in force\n- D-2 waived: Seam");
      expect(p).toContain("If a change you are about to make would undo one of these, do not make it.");
    }
    expect(buildFinishFixPrompt("review", { findings: [], rulings: "- D-2" })).toContain("evidence: ruling D-n");
    expect(buildFinishFixPrompt("gate", { rulings: "- D-2" })).not.toContain("evidence: ruling D-n");
  });

  test("review and gate fix prompts forbid acceptance-file edits; acceptance phase does not", () => {
    const paths = ["test/acceptance/feat.test.ts"];
    expect(buildFinishFixPrompt("review", { findings: [], acceptancePaths: paths })).toContain(
      "Do not edit the acceptance test files (test/acceptance/feat.test.ts) unless a finding below names the acceptance tests you may change.",
    );
    expect(buildFinishFixPrompt("gate", { acceptancePaths: paths })).toContain("Do not edit the acceptance test files");
    expect(buildFinishFixPrompt("acceptance", { acceptancePaths: paths })).not.toContain("Do not edit the acceptance test files");
  });

  test("no rulings, no section", () => {
    expect(buildFinishFixPrompt("review", { findings: [] })).not.toContain("Rulings in force");
  });
```

`test/unit/finish/fix/dispositions.test.ts`:

```ts
  test("a rejection citing a ruling shown to the session is valid; an unknown ruling id is missing", async () => {
    await withTempDir(async (dir) => {
      const out = await validateDispositions(
        dir,
        [
          { index: 1, disposition: "rejected", evidence: "ruling D-2" },
          { index: 2, disposition: "rejected", evidence: "ruling D-7" },
        ],
        ["D-2"],
      );
      expect(out[0]?.evidenceMissing).toBeUndefined();
      expect(out[1]?.evidenceMissing).toBe(true);
    });
  });
```

`test/unit/finish/ops-impl-a4.test.ts` — add (imports to add at the top: `join` from `node:path`, `withTempDir` and `makeAdviceDecision` from `@test/helpers`, `appendDecision` from `@/advisor`):

```ts
describe("rulings reach the quality lens and the fixer (finish B §4)", () => {
  async function trustedWaive(repo: string, outputDir: string): Promise<void> {
    const d = await appendDecision(repo, "demo", (id) => ({
      ...makeAdviceDecision({ action: { type: "waive", reason: "outOfScope" }, findingSeverity: "LOW" }),
      dedupeKey: "quality|Seam|src/t.ts",
      auditRef: `advisor-audit/demo/${id}.json`,
    }));
    await Bun.write(join(outputDir, d.auditRef), JSON.stringify({ result: { decision: d } }));
  }

  test("fix gets rulings, ruling ids and acceptance paths; reviewBranch gets decisions", async () => {
    await withTempDir(async (repo) => {
      const { deps } = baseDeps();
      await trustedWaive(repo, deps.callCtx.runtime.outputDir);
      const state = { ...freshState(), workdir: repo };
      const ops = createFinishOps(deps);

      const fixSeen = recordCallOp();
      await ops.fix("review", { state, findings: [], acceptancePaths: ["t.ts"] });
      expect(fixSeen.op).toBe(finishFixOp);
      expect(String(fixSeen.input?.rulings)).toContain("D-1 waived: Seam (src/t.ts) — outOfScope");
      expect(fixSeen.input?.rulingIds).toEqual(["D-1"]);
      expect(fixSeen.input?.acceptancePaths).toEqual(["t.ts"]);

      const reviewSeen = recordCallOp();
      await ops.reviewBranch(state, inputs);
      expect(String(reviewSeen.input?.decisions)).toContain("D-1 waived");
    });
  });

  test("no ledger: no rulings field on the fix input", async () => {
    await withTempDir(async (repo) => {
      const seen = recordCallOp();
      await createFinishOps(baseDeps().deps).fix("gate", { state: { ...freshState(), workdir: repo } });
      expect(seen.input && "rulings" in seen.input).toBe(false);
    });
  });
});
```

(`recordCallOp` returns `CLEAN` for the fix call too; `fix` returns whatever `callOp` returns, which is fine here because only the input is asserted. If `makeMockCallContext()`'s runtime has no `outputDir`, pass one: `makeMockCallContext({ runtime: … })` per `test/helpers/call-context.ts`.)

- [ ] **Step 2: Run, expect FAIL** — `timeout 30 bun test test/unit/advisor/format.test.ts test/unit/prompts/builders/finish-review-builder.test.ts test/unit/finish/fix/dispositions.test.ts test/unit/finish/ops-impl-a4.test.ts --timeout=5000`.

- [ ] **Step 3: Implement.**

`src/advisor/format.ts` (reuse the existing `waivedSubject`, `BLOCKING`, `describeTarget`):

```ts
/** Finish B §4.2: waive + supersede rulings a fixer must not undo, with the ids it may cite. */
export function formatRulingsForFix(decisions: readonly AdviceDecision[]): { text: string; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const d of decisions) {
    if (d.action.type === "waive" && !BLOCKING.has(d.findingSeverity ?? "")) {
      lines.push(`- ${d.id} waived: ${waivedSubject(d)} — ${d.action.reason}`);
      ids.push(d.id);
    }
    if (d.action.type === "supersede") {
      lines.push(`- ${d.id} superseded ${describeTarget(d.action.target)}: ${d.action.newText}`);
      ids.push(d.id);
    }
  }
  return { text: lines.join("\n"), ids };
}
```

Export it from `src/advisor/index.ts` next to `formatDecisionsForPrompt`.

`src/prompts/builders/finish-review-builder.ts`:
- `FinishBranchReviewPromptInput` gains `decisions?: string`; in `buildFinishBranchReviewPrompt` insert, right after the "Changed files" section:

```ts
    ...(input.decisions ? [`## Decisions already made (do not raise these again)\n${input.decisions}`] : []),
```

- Fix prompts:

```ts
const RULING_GUARD = "If a change you are about to make would undo one of these, do not make it.";
const RULING_REJECT =
  "A finding that can only be fixed by undoing a ruling is REJECTED, with `evidence: ruling D-n` (the ruling's id).";

function rulingsSection(phase: "acceptance" | "gate" | "review", rulings: string | undefined): string[] {
  if (!rulings) return [];
  return [`## Rulings in force\n${rulings}\n${RULING_GUARD}${phase === "review" ? `\n${RULING_REJECT}` : ""}`];
}

function acceptanceRule(phase: "acceptance" | "gate" | "review", paths: string[] | undefined): string[] {
  if (phase === "acceptance" || !paths || paths.length === 0) return [];
  return [
    `Do not edit the acceptance test files (${paths.join(", ")}) unless a finding below names the acceptance tests you may change.`,
  ];
}

export function buildFinishFixPrompt(
  phase: "acceptance" | "gate" | "review",
  args: {
    findings?: Finding[];
    gateOutput?: string;
    acceptanceOutput?: string;
    continuation?: FixContinuation;
    rulings?: string;
    acceptancePaths?: string[];
  },
): string {
  const body = phase === "review" ? buildReviewFixPrompt(args.findings ?? []) : buildPhaseFixPrompt(phase, args);
  const extras = [...rulingsSection(phase, args.rulings), ...acceptanceRule(phase, args.acceptancePaths)];
  const withExtras = extras.length > 0 ? `${body}\n\n${extras.join("\n\n")}` : body;
  return args.continuation ? `${withExtras}\n\n${continuationSection(args.continuation)}` : withExtras;
}
```

`src/operations/finish-branch-review.ts`: `FinishBranchReviewInput` gains `decisions?: string` (the builder receives the input object as today).

`src/operations/finish-fix.ts`: `FinishFixInput` gains

```ts
  /** Finish B §4.2: rulings in force, rendered; and the ids a rejection may cite. */
  rulings?: string;
  rulingIds?: string[];
  /** Finish B §6.2: acceptance test files review and gate fixers may not edit unless a finding allows it. */
  acceptancePaths?: string[];
```

`build` passes `rulings: input.rulings, acceptancePaths: input.acceptancePaths` to `buildFinishFixPrompt`; `verify` becomes `validateDispositions(input.workdir, parsed.dispositions ?? [], input.rulingIds ?? [])`.

`src/finish/fix/dispositions.ts`:

```ts
const RULING_EVIDENCE = /^ruling (D-\d+)$/;

export async function validateDispositions(
  workdir: string,
  dispositions: FindingDisposition[],
  rulingIds: readonly string[] = [],
): Promise<FindingDisposition[]> {
  return Promise.all(
    dispositions.map(async (d) => {
      if (d.disposition !== "rejected" || !d.evidence) return d;
      const ruling = RULING_EVIDENCE.exec(d.evidence.trim());
      if (ruling) return rulingIds.includes(ruling[1] ?? "") ? d : { ...d, evidenceMissing: true };
      const file = d.evidence.split(":")[0];
      return (await exists(workdir, file)) ? d : { ...d, evidenceMissing: true };
    }),
  );
}
```

`src/finish/ops.ts` `FixRequest` gains `acceptancePaths?: string[];` (callers fill it in Task 8/9; omitted today is fine).

`src/finish/ops-impl.ts`:

```ts
/** Finish B §4.2: rulings in force for a fixer. Never throws: no ledger reads as none. */
async function loadFixRulings(state: FinishState, outputDir: string | undefined): Promise<{ text: string; ids: string[] }> {
  if (!outputDir) return { text: "", ids: [] };
  const decisions = await readTrustedDecisions(state.workdir, state.feature, outputDir).catch(() => []);
  return formatRulingsForFix(decisions);
}
```

In `fix`, before building `input`: `const rulings = await loadFixRulings(state, advisorOutputDir);` and add to `input`:

```ts
        ...(rulings.text ? { rulings: rulings.text, rulingIds: rulings.ids } : {}),
        ...(req.acceptancePaths ? { acceptancePaths: req.acceptancePaths } : {}),
```

In `reviewBranch`, add `decisions: await loadDecisionNotes(state, advisorOutputDir),` to the input.

- [ ] **Step 4: Run, expect PASS** — same command as Step 2, plus `timeout 30 bun test test/unit/operations/ --timeout=5000` if finish-fix op tests exist there.

- [ ] **Step 5: Commit** — `git commit -m "feat(finish): show rulings to the quality lens and every fix session"`

---

### Task 6: Find the acceptance tests a finding touches

**Files:**
- Create: `src/finish/acceptance-evidence.ts`
- Modify: `src/finish/index.ts`
- Test: `test/unit/finish/acceptance-evidence.test.ts`

**Interfaces:**
- Produces:

```ts
export interface AcceptanceFile { path: string; text: string }
export interface AcBlock { acId: string; text: string }
export interface PinnedAc { path: string; acId: string; excerpt: string; score: number }
export const MAX_PINNED_BLOCKS = 5;
export const EXCERPT_LINES = 40;
export function splitAcBlocks(text: string): AcBlock[];
export function findingIdentifiers(f: Pick<Finding, "title" | "problem" | "file">): string[];
export function findPinnedAcs(files: AcceptanceFile[], f: Pick<Finding, "title" | "problem" | "file">): PinnedAc[];
export async function loadAcceptanceFiles(workdir: string, paths: string[]): Promise<AcceptanceFile[]>;
export const _acceptanceEvidenceDeps: { readText: (path: string) => Promise<string | null> };
```

- [ ] **Step 1: Write the failing tests:**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { findingIdentifiers, findPinnedAcs, loadAcceptanceFiles, splitAcBlocks } from "@/finish";

const ts = [
  'import { emit } from "../src/session-event";',
  'test("AC-40: session_event carries the run envelope", () => {',
  "  expect(emit().envelope).toBeDefined();",
  "});",
  'test("AC-51: costSpentUsd is written per job", () => {',
  "  expect(row.costSpentUsd).toBe(1);",
  "});",
  'test("AC-52: unrelated", () => {});',
].join("\n");

const go = [
  "func TestAC40SessionEnvelope(t *testing.T) { // AC-40",
  "  if emit().Envelope == nil { t.Fatal() }",
  "}",
].join("\n");

describe("splitAcBlocks", () => {
  test("a block runs from the first mention of an AC id to the next anchor", () => {
    const blocks = splitAcBlocks(ts);
    expect(blocks.map((b) => b.acId)).toEqual(["AC-40", "AC-51", "AC-52"]);
    expect(blocks[0]?.text).toContain("envelope");
    expect(blocks[0]?.text).not.toContain("costSpentUsd");
  });
  test("language-neutral: a Go file with the AC id in a comment still splits", () => {
    expect(splitAcBlocks(go).map((b) => b.acId)).toEqual(["AC-40"]);
  });
  test("a later mention of an already-seen AC id does not start a new block", () => {
    expect(splitAcBlocks("// AC-1 a\nx\n// see AC-1 again\n// AC-2 b").map((b) => b.acId)).toEqual(["AC-1", "AC-2"]);
  });
  test("no AC ids: no blocks (Review Focus 5)", () => {
    expect(splitAcBlocks('test("works", () => {});')).toEqual([]);
  });
});

describe("findingIdentifiers", () => {
  test("backticked tokens, code-style title words and the anchor base name", () => {
    const ids = findingIdentifiers({
      title: "Write-only costSpentUsd column on thread_job",
      problem: "`costSpentUsd` is never read; see `ThreadJob.save`",
      file: "src/db/thread-job.ts",
    });
    expect(ids).toEqual(expect.arrayContaining(["costSpentUsd", "thread_job", "ThreadJob.save", "thread-job"]));
    expect(ids).not.toContain("column");
  });
});

describe("findPinnedAcs", () => {
  const files = [{ path: "test/acceptance/feat.test.ts", text: ts }];
  test("#2468: the finding about costSpentUsd pins AC-51 only", () => {
    const pinned = findPinnedAcs(files, { title: "Remove write-only `costSpentUsd`", problem: "p", file: "src/x.ts" });
    expect(pinned.map((p) => p.acId)).toEqual(["AC-51"]);
    expect(pinned[0]?.path).toBe("test/acceptance/feat.test.ts");
  });
  test("ordered by score, capped at 5 blocks, excerpts capped at 40 lines", () => {
    const many = Array.from({ length: 8 }, (_, i) => `// AC-${i + 1} fooBar\n${"line\n".repeat(60)}`).join("");
    const pinned = findPinnedAcs([{ path: "a.ts", text: many }], { title: "fooBar breaks", problem: "", file: undefined });
    expect(pinned).toHaveLength(5);
    expect(pinned[0]?.excerpt.split("\n").length).toBeLessThanOrEqual(40);
  });
  test("no identifiers or no AC ids: nothing", () => {
    expect(findPinnedAcs([{ path: "a.ts", text: "plain" }], { title: "fooBar", problem: "", file: undefined })).toEqual([]);
  });
});

describe("loadAcceptanceFiles", () => {
  test("reads existing files; a missing one is skipped, never thrown", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "t.ts"), ts);
      const out = await loadAcceptanceFiles(dir, ["t.ts", "missing.ts"]);
      expect(out.map((f) => f.path)).toEqual(["t.ts"]);
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `timeout 30 bun test test/unit/finish/acceptance-evidence.test.ts --timeout=5000`.

- [ ] **Step 3: Implement** `src/finish/acceptance-evidence.ts`:

```ts
/**
 * Finish B §5.1: the generated acceptance tests a finding would touch. Pure except
 * `loadAcceptanceFiles`. Language-neutral: blocks are found by AC id only, never by
 * test-framework syntax. A file with no AC ids gives no blocks.
 */
import { basename, extname, join } from "node:path";
import type { Finding } from "./types";

export interface AcceptanceFile {
  path: string;
  text: string;
}
export interface AcBlock {
  acId: string;
  text: string;
}
export interface PinnedAc {
  path: string;
  acId: string;
  excerpt: string;
  score: number;
}

export const MAX_PINNED_BLOCKS = 5;
export const EXCERPT_LINES = 40;
const AC_ID = /\bAC-\d+\b/;
/** camelCase, PascalCase with an inner capital, snake_case, or dotted names: words a reviewer would quote as code. */
const CODE_WORD = /\b(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[a-z0-9]+_[a-z0-9_]+|[A-Za-z_]\w*\.[A-Za-z_][\w.]*)\b/g;
const BACKTICK = /`([^`\n]+)`/g;

export function splitAcBlocks(text: string): AcBlock[] {
  const lines = text.split("\n");
  const seen = new Set<string>();
  const anchors: { acId: string; at: number }[] = [];
  lines.forEach((line, at) => {
    const id = AC_ID.exec(line)?.[0];
    if (id && !seen.has(id)) {
      seen.add(id);
      anchors.push({ acId: id, at });
    }
  });
  return anchors.map((a, i) => ({
    acId: a.acId,
    text: lines.slice(a.at, anchors[i + 1]?.at ?? lines.length).join("\n"),
  }));
}

export function findingIdentifiers(f: Pick<Finding, "title" | "problem" | "file">): string[] {
  const ids = new Set<string>();
  for (const m of `${f.title}\n${f.problem}`.matchAll(BACKTICK)) if (m[1]) ids.add(m[1].trim());
  for (const m of f.title.matchAll(CODE_WORD)) ids.add(m[0]);
  if (f.file) ids.add(basename(f.file, extname(f.file)));
  return [...ids].filter((s) => s.length >= 3);
}

export function findPinnedAcs(files: AcceptanceFile[], f: Pick<Finding, "title" | "problem" | "file">): PinnedAc[] {
  const ids = findingIdentifiers(f);
  if (ids.length === 0) return [];
  const scored = files.flatMap((file) =>
    splitAcBlocks(file.text).map((b) => ({
      path: file.path,
      acId: b.acId,
      excerpt: b.text.split("\n").slice(0, EXCERPT_LINES).join("\n"),
      score: ids.filter((id) => b.text.includes(id)).length,
    })),
  );
  return scored
    .filter((p) => p.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PINNED_BLOCKS);
}

export const _acceptanceEvidenceDeps = {
  readText: (path: string): Promise<string | null> =>
    Bun.file(path)
      .text()
      .catch(() => null),
};

export async function loadAcceptanceFiles(workdir: string, paths: string[]): Promise<AcceptanceFile[]> {
  const texts = await Promise.all(paths.map((p) => _acceptanceEvidenceDeps.readText(join(workdir, p))));
  return paths.flatMap((path, i) => {
    const text = texts[i];
    return typeof text === "string" ? [{ path, text }] : [];
  });
}
```

Note on the AC-40 import line in the TS fixture: the import line has no AC id, so it belongs to no block; this is intended (imports are file-wide, not per-AC).

Export all public names from `src/finish/index.ts`.

- [ ] **Step 4: Run, expect PASS** — same command.

- [ ] **Step 5: Commit** — `git commit -m "feat(finish): find the acceptance tests a finding touches, by AC id"`

---

### Task 7: Menu option "fix and update the acceptance tests"

**Files:**
- Modify: `src/advisor/types.ts` (`AdviceAction` fix, `AdviceOptionFixed`, `MenuFacts` finish-judgment, `AdviceDecision.acceptanceChanges`)
- Modify: `src/advisor/menus.ts` (`buildMenu`, `toAction`)
- Modify: `src/advisor/service.ts` (`buildDraft`)
- Modify: `src/prompts/builders/advisor-builder.ts` (POLICY item 7)
- Test: `test/unit/advisor/menus.test.ts`, `test/unit/advisor/service.test.ts`

**Interfaces:**
- Produces: `AdviceAction` `{ type: "fix"; instruction: string; updateAcs?: string[] }`; `AdviceOptionFixed.updateAcs?: string[]`; `MenuFacts["finish-judgment"].pinnedAcs?: string[]`; `AdviceDecision.acceptanceChanges?: string[]`.

- [ ] **Step 1: Write the failing tests.** `test/unit/advisor/menus.test.ts`:

```ts
  test("finish-judgment with pinned ACs: plain fix relabelled, fix-and-update added after it", () => {
    const menu = buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true, pinnedAcs: ["AC-40", "AC-51"] });
    expect(menu.map((o) => o.type)).toEqual(["fix", "fix", "waive", "hold"]);
    expect(menu[0]?.label).toBe("Fix without changing the acceptance tests");
    expect(menu[1]?.fixed).toEqual({ updateAcs: ["AC-40", "AC-51"] });
    expect(menu[1]?.label).toBe("Fix, and update acceptance tests AC-40, AC-51 (say what changes in them)");
  });

  test("no pinned ACs: the menu is unchanged", () => {
    expect(buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true, pinnedAcs: [] })[0]?.label).toBe(
      "Fix it, with the approach you describe",
    );
  });

  test("toAction carries updateAcs on a fix-and-update option only", () => {
    const opt = { id: "B", type: "fix" as const, label: "l", fixed: { updateAcs: ["AC-40"] } };
    expect(toAction(opt, reply({ instruction: "revert envelope; update AC-40" }))).toEqual({
      type: "fix",
      instruction: "revert envelope; update AC-40",
      updateAcs: ["AC-40"],
    });
    expect(toAction({ id: "A", type: "fix", label: "l" }, reply({ instruction: "i" }))).toEqual({ type: "fix", instruction: "i" });
  });
```

`test/unit/advisor/service.test.ts`:

```ts
  test("a fix-and-update ruling records acceptanceChanges on the decision (finish B §6.4)", async () => {
    await withTempDir(async (dir) => {
      stubDeps(reply("B", { instruction: "revert; update AC-40" }));
      const options = buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true, pinnedAcs: ["AC-40"] });
      const out = await createAdvisor(actx(dir)).advise({ ...judgment, options });
      expect(out.decision?.acceptanceChanges).toEqual(["AC-40"]);
    });
  });
```

- [ ] **Step 2: Run, expect FAIL** — `timeout 30 bun test test/unit/advisor/ --timeout=5000`.

- [ ] **Step 3: Implement.**

`types.ts`: change the fix arm to `| { type: "fix"; instruction: string; updateAcs?: string[] }`; add `updateAcs?: string[];` to `AdviceOptionFixed`; add `pinnedAcs?: string[];` to the finish-judgment `MenuFacts` arm; add to `AdviceDecision`:

```ts
  /** Finish B §6.4: the acceptance tests a fix-and-update ruling allows to change. */
  acceptanceChanges?: string[];
```

`menus.ts`:

```ts
function fixDrafts(pinnedAcs: string[] | undefined): Draft[] {
  if (!pinnedAcs || pinnedAcs.length === 0) return [{ type: "fix" }];
  return [
    { type: "fix", label: "Fix without changing the acceptance tests" },
    {
      type: "fix",
      fixed: { updateAcs: pinnedAcs },
      label: `Fix, and update acceptance tests ${pinnedAcs.join(", ")} (say what changes in them)`,
    },
  ];
}
```

`case "finish-judgment":` becomes `withIds([...fixDrafts(facts.pinnedAcs), { type: "waive" }, ...supersedeDraft(...), { type: "hold" }])`.

`toAction`: split `fix` from `retry`:

```ts
    case "fix":
      return {
        type: "fix",
        instruction: text("instruction"),
        ...(option.fixed?.updateAcs ? { updateAcs: option.fixed.updateAcs } : {}),
      };
    case "retry":
      return { type: "retry", instruction: text("instruction") };
```

`service.ts` `buildDraft`, after the `rulingTitle` spread:

```ts
    ...(action.type === "fix" && action.updateAcs ? { acceptanceChanges: action.updateAcs } : {}),
```

`advisor-builder.ts` POLICY: append item 7:

```
7. An acceptance test excerpt in the evidence that asserts the behaviour the finding wants changed means a plain fix turns acceptance red. Then choose "Fix, and update acceptance tests" (say exactly what changes in them), waive (the test pins the behaviour on purpose), or supersede.
```

(Check `test/unit/prompts/builders/advisor-builder.test.ts` if it snapshots POLICY; update that expectation in the same commit.)

- [ ] **Step 4: Run, expect PASS** — `timeout 30 bun test test/unit/advisor/ test/unit/prompts/ --timeout=5000`.

- [ ] **Step 5: Commit** — `git commit -m "feat(advisor): offer fix-and-update-acceptance on judgment questions"`

---

### Task 8: Judgment questions carry acceptance evidence; a fix-and-update ruling allows those edits

**Files:**
- Modify: `src/finish/types.ts` (`Finding.allowedAcceptanceEdits`)
- Modify: `src/finish/advise.ts` (`JudgeContext`, `judgmentQuestion`, `contradictionQuestion`, `adviseOn`, `judged` signature)
- Modify: `src/finish/advise-rulings.ts`, `src/finish/review-rulings.ts`, `src/finish/review-loop.ts` (thread `JudgeContext`; `ReviewLoopDeps.acceptancePaths`)
- Modify: `src/finish/machine.ts` (`reviewLoopDeps`)
- Test: `test/unit/finish/advise-rulings.test.ts`, `test/unit/finish/review-loop-rulings.test.ts`

**Interfaces:**
- Consumes: Task 6 (`AcceptanceFile`, `findPinnedAcs`, `loadAcceptanceFiles`), Task 7 (`pinnedAcs`, `updateAcs`).
- Produces:

```ts
// types.ts — Finding
  /** Finish B §5.3: set by finish (never the model) when a ruling allows these acceptance-test edits. */
  allowedAcceptanceEdits?: { testPath: string; acIds: string[] }[];
// advise.ts
export interface JudgeContext { acceptance: AcceptanceFile[] }
judged(findings, contradictions, state, jctx?: JudgeContext): Promise<JudgedResult>;
reconcile(check, budget, jctx?: JudgeContext): Promise<{ result: JudgedResult; asked: number }>;
// review-loop.ts — ReviewLoopDeps
  /** Finish B: repo-relative acceptance test paths that exist; [] when acceptance is disabled. */
  acceptancePaths?: string[];
```

- [ ] **Step 1: Write the failing tests.** In `test/unit/finish/advise-rulings.test.ts`:

```ts
describe("acceptance evidence on judgment questions (#2468)", () => {
  const acceptance = [
    { path: "test/acceptance/feat.test.ts", text: 'test("AC-51: costSpentUsd is written", () => { row.costSpentUsd; });' },
  ];
  const finding = low({ title: "Remove write-only `costSpentUsd`", judgment: true, file: "src/db/job.ts" });

  test("the question carries the pinned AC as evidence and the fix-and-update option", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: null }));
      await make(dir, advisor).judged([finding], [], state(dir), { acceptance });
      expect(asked[0]?.evidence.some((e) => e.source === "ac" && e.ref === "test/acceptance/feat.test.ts#AC-51")).toBe(true);
      expect(asked[0]?.options.find((o) => o.fixed?.updateAcs)?.fixed?.updateAcs).toEqual(["AC-51"]);
    });
  });

  test("a fix-and-update ruling names the ACs in the fix and sets allowedAcceptanceEdits", async () => {
    await withTempDir(async (dir) => {
      const { advisor } = fakeAdvisor(() => ({
        decision: decision({ action: { type: "fix", instruction: "drop the column", updateAcs: ["AC-51"] } }),
      }));
      const out = await make(dir, advisor).judged([finding], [], state(dir), { acceptance });
      expect(out.toFix[0]?.fix).toContain("You may edit these acceptance tests, and only these: AC-51 in test/acceptance/feat.test.ts.");
      expect(out.toFix[0]?.allowedAcceptanceEdits).toEqual([{ testPath: "test/acceptance/feat.test.ts", acIds: ["AC-51"] }]);
    });
  });

  test("acceptance disabled: no evidence, plain menu", async () => {
    await withTempDir(async (dir) => {
      const { advisor, asked } = fakeAdvisor(() => ({ decision: null }));
      const fa = createFinishAdvisor({
        advisor, repoRoot: dir, outputDir: join(dir, "out"), feature: "feat",
        acceptanceEnabled: () => false, judgedEnabled: true, approvalEnabled: false,
        git: async () => ({ exitCode: 0 }),
      });
      await fa.judged([finding], [], state(dir), { acceptance });
      expect(asked[0]?.evidence.some((e) => e.source === "ac")).toBe(false);
      expect(asked[0]?.options.some((o) => o.fixed?.updateAcs)).toBe(false);
    });
  });
});
```

In `test/unit/finish/review-loop-rulings.test.ts`, one test that a round with `acceptancePaths: ["t.ts"]` (file written in `dir` with an AC-51 block mentioning `costSpentUsd`) sends the judgment question with `ac` evidence (add `acceptancePaths` to `loopDeps` via a parameter).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**

`advise.ts`:

```ts
import { type AcceptanceFile, findPinnedAcs, type PinnedAc } from "./acceptance-evidence";

export interface JudgeContext {
  acceptance: AcceptanceFile[];
}

function pinnedFor(deps: FinishAdvisorDeps, f: Finding, jctx: JudgeContext | undefined): PinnedAc[] {
  if (!jctx || !deps.acceptanceEnabled()) return [];
  return findPinnedAcs(jctx.acceptance, f);
}
```

`judgmentQuestion(deps, phase, f, jctx?)`: compute `const pinned = pinnedFor(deps, f, jctx);`, append evidence

```ts
      ...pinned.map((p) => ({ source: "ac" as const, ref: `${p.path}#${p.acId}`, text: p.excerpt })),
```

and pass `...(pinned.length > 0 ? { pinnedAcs: [...new Set(pinned.map((p) => p.acId))] } : {})` into `buildMenu`. Same for `contradictionQuestion` over `c.spec` and `c.quality` combined (dedupe by `path#acId`).

`adviseOn(deps, question, f, pinned: PinnedAc[] = [])`: in the `fix` branch,

```ts
  const acs = action.updateAcs ?? [];
  if (acs.length === 0) return { ref, keep: { ...f, fix: `${f.fix}\n\nAdvisor ruling (${decision.id}): ${action.instruction}` } };
  const allowed = allowedEdits(pinned, acs);
  const where = allowed.map((a) => `${a.acIds.join(", ")} in ${a.testPath}`).join("; ");
  return {
    ref,
    keep: {
      ...f,
      fix: `${f.fix}\n\nAdvisor ruling (${decision.id}): ${action.instruction}. You may edit these acceptance tests, and only these: ${where}.`,
      allowedAcceptanceEdits: allowed,
    },
  };
```

with

```ts
function allowedEdits(pinned: PinnedAc[], acIds: string[]): { testPath: string; acIds: string[] }[] {
  const byPath = new Map<string, string[]>();
  for (const p of pinned) {
    if (!acIds.includes(p.acId)) continue;
    byPath.set(p.path, [...(byPath.get(p.path) ?? []), p.acId]);
  }
  return [...byPath.entries()].map(([testPath, ids]) => ({ testPath, acIds: [...new Set(ids)] }));
}
```

`judgeOne(deps, phase, f, jctx?)` computes `pinned` once, builds the question with `jctx`, and calls `adviseOn(deps, question, f, pinned)`. `judged(findings, contradictions, _state, jctx?)` threads `jctx` to `judgeOne`; `judgeContradiction` adds the same allowed-edits handling on its `fix` branch using the contradiction's pinned list. `nearQuestion` and `reconcileRulings` take `jctx?` and pass it through (`judgmentQuestion(deps, …, jctx)`, `adviseOn(…, pinnedFor(deps, finding, jctx))` — export `pinnedFor`).

`FinishAdvisor`: `judged(findings, contradictions, state, jctx?)`, `reconcile(check, budget, jctx?)`; `createFinishAdvisor` passes them through.

`review-loop.ts`: `ReviewLoopDeps.acceptancePaths?: string[]`. In `runOneRound`, after the abort check that follows the lenses:

```ts
  const jctx: JudgeContext = { acceptance: await loadAcceptanceFiles(state.workdir, deps.acceptancePaths ?? []) };
```

Pass `jctx` to `reconcileBefore(deps, merged, jctx)`, `judgeRound(state, deps, before.merged, jctx)` (→ `advisor.judged(..., jctx)`), `reconcileAfter(deps, …, jctx)` (→ `advisor.reconcile(check, budget, jctx)`).

`machine.ts` `reviewLoopDeps(deps, inputs)` adds:

```ts
    acceptancePaths:
      deps.context.acceptanceStatus === "disabled"
        ? []
        : deps.context.groups.filter((g) => g.exists).map((g) => g.testPath),
```

- [ ] **Step 4: Run, expect PASS** — `timeout 30 bun test test/unit/finish/ --timeout=5000`.

- [ ] **Step 5: Commit** — `git commit -m "feat(finish): judgment questions see the acceptance tests a ruling would contradict"`

---

### Task 9: Guard the acceptance file in review and gate fix sessions

**Files:**
- Create: `src/finish/acceptance-guard.ts`
- Modify: `src/finish/state.ts` (`acceptanceGuard`), `src/finish/review-loop.ts` (`fixRound`), `src/finish/gates-loop.ts` (`fixOnce`), `src/finish/ops.ts` callers pass `acceptancePaths`
- Test: `test/integration/finish/acceptance-guard.test.ts` (real git), `test/unit/finish/review-loop-rulings.test.ts` (wiring)

**Interfaces:**
- Produces:

```ts
// state.ts
export interface AcceptanceGuardRecord { reverted: string[]; changed: string[]; beyondRuling: string[]; failed: boolean }
// FinishState
  acceptanceGuard?: AcceptanceGuardRecord;
// acceptance-guard.ts
export interface GuardOutcome { reverted: string[]; changed: string[]; beyondRuling: string[]; failed: boolean }
export async function guardAcceptanceEdits(args: {
  workdir: string;
  paths: string[];                                         // repo-relative acceptance test paths
  allowed: { testPath: string; acIds: string[] }[];        // union over the session's findings
}): Promise<GuardOutcome>;
export function mergeGuard(prev: AcceptanceGuardRecord | undefined, next: GuardOutcome): AcceptanceGuardRecord;
export function allowedFrom(findings: Finding[] | undefined): { testPath: string; acIds: string[] }[];
```

- [ ] **Step 1: Write the failing integration tests** — `test/integration/finish/acceptance-guard.test.ts`, using the real-git fixture:

```ts
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { guardAcceptanceEdits } from "@/finish/acceptance-guard";
import { commitAll, git, withRepo } from "./set-aside-fixture";

const ACC = "test/acceptance/feat file.test.ts"; // a space, on purpose (Review Focus 4)
const original = '// AC-40 envelope\nexpect(envelope);\n// AC-51 cost\nexpect(cost);\n';

async function seed(dir: string): Promise<void> {
  await mkdir(join(dir, "test/acceptance"), { recursive: true });
  await writeFile(join(dir, ACC), original);
  await commitAll(dir, "acceptance");
}

describe("guardAcceptanceEdits", () => {
  test("an unauthorised edit is restored from HEAD and reported", async () => {
    await withRepo(async (dir) => {
      await seed(dir);
      await writeFile(join(dir, ACC), original.replace("expect(cost)", "// removed"));
      await writeFile(join(dir, "a.ts"), "export const a = 2;\n"); // a normal fix edit stays
      const out = await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [] });
      expect(out).toEqual({ reverted: [ACC], changed: [], beyondRuling: [], failed: false });
      expect(await Bun.file(join(dir, ACC)).text()).toBe(original);
      expect(await git(dir, "status", "--porcelain")).toContain("a.ts");
    });
  });

  test("an authorised edit is kept; changed ACs recorded; a changed AC outside the ruling is flagged", async () => {
    await withRepo(async (dir) => {
      await seed(dir);
      await writeFile(join(dir, ACC), original.replace("expect(envelope)", "expect(flat)").replace("expect(cost)", "// gone"));
      const out = await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [{ testPath: ACC, acIds: ["AC-40"] }] });
      expect(out.reverted).toEqual([]);
      expect(out.changed.sort()).toEqual(["AC-40", "AC-51"]);
      expect(out.beyondRuling).toEqual(["AC-51"]);
      expect(await Bun.file(join(dir, ACC)).text()).toContain("expect(flat)");
    });
  });

  test("untouched acceptance file: nothing reported", async () => {
    await withRepo(async (dir) => {
      await seed(dir);
      expect(await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [] })).toEqual({
        reverted: [], changed: [], beyondRuling: [], failed: false,
      });
    });
  });

  test("a path absent at HEAD is left alone and not counted as reverted (Review Focus 4)", async () => {
    await withRepo(async (dir) => {
      await mkdir(join(dir, "test/acceptance"), { recursive: true });
      await writeFile(join(dir, ACC), "// AC-1 new\n");
      const out = await guardAcceptanceEdits({ workdir: dir, paths: [ACC], allowed: [] });
      expect(out.reverted).toEqual([]);
      expect(await Bun.file(join(dir, ACC)).exists()).toBe(true);
    });
  });

  test("no paths: no git call, nothing reported", async () => {
    expect(await guardAcceptanceEdits({ workdir: "/nonexistent", paths: [], allowed: [] })).toEqual({
      reverted: [], changed: [], beyondRuling: [], failed: false,
    });
  });
});
```

Wiring test in `test/unit/finish/review-loop-rulings.test.ts`: stub `_acceptanceGuardDeps.guard` (see below) to return `{ reverted: ["t.ts"], changed: [], beyondRuling: [], failed: false }`, run one round with one plain finding and `acceptancePaths: ["t.ts"]`, assert `state.acceptanceGuard?.reverted` is `["t.ts"]`, the guard was called with `allowed: []`, and the fix request carried `acceptancePaths: ["t.ts"]`.

- [ ] **Step 2: Run, expect FAIL** — `timeout 60 bun test test/integration/finish/acceptance-guard.test.ts --timeout=20000`.

- [ ] **Step 3: Implement** `src/finish/acceptance-guard.ts`:

```ts
/**
 * Finish B §6.3: after a review or gate fix session, before its commit. An acceptance
 * test file the session edited without a ruling naming its ACs is put back to HEAD,
 * path only. Authorised edits stay; the AC blocks that changed are reported, and any
 * outside the ruling is flagged (not reverted). Git failures are reported as
 * `failed: true`, never thrown: the commit goes ahead.
 */
import { join } from "node:path";
import { splitAcBlocks } from "./acceptance-evidence";
import { gitLiteral, listBaseTree, repoRoot } from "./set-aside-git";
import type { AcceptanceGuardRecord } from "./state";
import type { Finding } from "./types";

export interface GuardOutcome {
  reverted: string[];
  changed: string[];
  beyondRuling: string[];
  failed: boolean;
}

const NONE: GuardOutcome = { reverted: [], changed: [], beyondRuling: [], failed: false };

export const _acceptanceGuardDeps = {
  readText: (path: string): Promise<string | null> =>
    Bun.file(path)
      .text()
      .catch(() => null),
};

export function allowedFrom(findings: Finding[] | undefined): { testPath: string; acIds: string[] }[] {
  return (findings ?? []).flatMap((f) => f.allowedAcceptanceEdits ?? []);
}

async function changedPaths(root: string, paths: string[]): Promise<string[] | null> {
  const res = await gitLiteral(["diff", "--name-only", "-z", "HEAD", "--", ...paths], root);
  return res.exitCode === 0 ? res.stdout.split("\0").filter(Boolean) : null;
}

function changedAcs(before: string, after: string): string[] {
  const was = new Map(splitAcBlocks(before).map((b) => [b.acId, b.text]));
  const now = new Map(splitAcBlocks(after).map((b) => [b.acId, b.text]));
  const ids = new Set([...was.keys(), ...now.keys()]);
  return [...ids].filter((id) => was.get(id) !== now.get(id));
}

async function acsChangedIn(root: string, path: string): Promise<string[]> {
  const head = await gitLiteral(["show", `HEAD:${path}`], root);
  const after = await _acceptanceGuardDeps.readText(join(root, path));
  return changedAcs(head.exitCode === 0 ? head.stdout : "", after ?? "");
}

export async function guardAcceptanceEdits(args: {
  workdir: string;
  paths: string[];
  allowed: { testPath: string; acIds: string[] }[];
}): Promise<GuardOutcome> {
  if (args.paths.length === 0) return NONE;
  const root = await repoRoot(args.workdir);
  const [changed, inHead] = await Promise.all([changedPaths(root, args.paths), listBaseTree(root, "HEAD")]);
  if (changed === null || inHead === null) return { ...NONE, failed: true };
  const allowedPaths = new Set(args.allowed.map((a) => a.testPath));
  const unauthorised = changed.filter((p) => !allowedPaths.has(p) && inHead.has(p));
  const restore =
    unauthorised.length > 0
      ? await gitLiteral(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...unauthorised], root)
      : { exitCode: 0 };
  const authorised = changed.filter((p) => allowedPaths.has(p));
  const perPath = await Promise.all(authorised.map(async (p) => ({ p, acs: await acsChangedIn(root, p) })));
  const ruled = new Set(args.allowed.flatMap((a) => a.acIds));
  const changedIds = [...new Set(perPath.flatMap((x) => x.acs))];
  return {
    reverted: restore.exitCode === 0 ? unauthorised : [],
    changed: changedIds,
    beyondRuling: changedIds.filter((id) => !ruled.has(id)),
    failed: restore.exitCode !== 0,
  };
}

export function mergeGuard(prev: AcceptanceGuardRecord | undefined, next: GuardOutcome): AcceptanceGuardRecord {
  const u = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])];
  return {
    reverted: u(prev?.reverted, next.reverted),
    changed: u(prev?.changed, next.changed),
    beyondRuling: u(prev?.beyondRuling, next.beyondRuling),
    failed: (prev?.failed ?? false) || next.failed,
  };
}
```

Note: `gitLiteral` prefixes `--literal-pathspecs`, so the space in the path is literal; `git show HEAD:<path>` takes a revision:path argument, not a pathspec, which is fine.

Also add an injectable seam so loop tests can stub the guard without git:

```ts
export const _guardDeps = { guard: guardAcceptanceEdits };
```

`state.ts`: add the `AcceptanceGuardRecord` interface (exported) and `acceptanceGuard?: AcceptanceGuardRecord;` on `FinishState` with a doc comment "Finish B §6.4: what the acceptance-file guard did, across sessions".

`review-loop.ts` `fixRound`, after `step.kind === "done"` and before `buildFixCommitMessage`:

```ts
  const guard = await _guardDeps.guard({
    workdir: state.workdir,
    paths: deps.acceptancePaths ?? [],
    allowed: allowedFrom(fixList),
  });
  if (guard.reverted.length + guard.changed.length > 0 || guard.failed) {
    state.acceptanceGuard = mergeGuard(state.acceptanceGuard, guard);
  }
```

and the `runFixStep(state, deps.fix, "review", { findings: fixList })` call gains `acceptancePaths: deps.acceptancePaths ?? []`.

`gates-loop.ts` `fixOnce`: compute `const paths = deps.context.acceptanceStatus === "disabled" ? [] : deps.context.groups.filter((g) => g.exists).map((g) => g.testPath);` (extract this into a tiny exported helper `acceptancePathsOf(context: FinishContext): string[]` in `acceptance-guard.ts` and use it from both `machine.ts` (Task 8 site) and here), pass `acceptancePaths: paths` into `runFixStep`, and run the same guard block (with `allowed: []`, since gate fixes carry no findings) before its `commitFixes`.

`runFixStep`'s `req` type is `Omit<FixRequest, "state" | "interrupt" | "continuation">`, so `acceptancePaths` flows through to `ops.fix` with no change there; `ops-impl.ts` already forwards it (Task 5).

- [ ] **Step 4: Run, expect PASS** — `timeout 60 bun test test/integration/finish/acceptance-guard.test.ts --timeout=20000` and `timeout 30 bun test test/unit/finish/ --timeout=5000`.

- [ ] **Step 5: Commit** — `git commit -m "feat(finish): guard the acceptance file in review and gate fix sessions"`

---

### Task 10: PR body shows acceptance changes and the guard's actions

**Files:**
- Modify: `src/finish/pr/body.ts` (`buildAdvisorSection`, `buildUnresolvedSection`)
- Modify: `src/finish/pr/context.ts` (`FinishPrContext.unresolved.acceptanceGuard`, `fromResolution`)
- Test: `test/unit/finish/pr-body.test.ts`

**Interfaces:**
- Consumes: `AdviceDecision.acceptanceChanges` (Task 7), `FinishState.acceptanceGuard` (Task 9).
- Produces: `FinishPrContext["unresolved"]["acceptanceGuard"]?: AcceptanceGuardRecord`.

- [ ] **Step 1: Write the failing tests** (use the context factory already used in `pr-body.test.ts`; find it with `grep -n "function ctx\|makePrContext" test/unit/finish/pr-body.test.ts`):

```ts
  test("a decision with acceptanceChanges says which acceptance tests changed (finish B §6.4)", () => {
    const body = buildFinishBody(ctxWith({
      advisorDecisions: [makeAdviceDecision({ id: "D-3", action: { type: "fix", instruction: "i", updateAcs: ["AC-40"] }, acceptanceChanges: ["AC-40", "AC-51"] })],
    }));
    expect(body).toContain("— acceptance tests changed: AC-40, AC-51");
  });

  test("the Unresolved section lists guard reverts, beyond-ruling changes and a failed check", () => {
    const body = buildFinishBody(ctxWith({
      unresolved: { ...draftUnresolved(), acceptanceGuard: { reverted: ["t.ts"], changed: ["AC-51"], beyondRuling: ["AC-51"], failed: true } },
    }));
    expect(body).toContain("- Acceptance-file edits reverted: t.ts");
    expect(body).toContain("- Acceptance tests changed beyond the ruling: AC-51");
    expect(body).toContain("- acceptance-file check could not run");
  });
```

(`ctxWith` / `draftUnresolved` stand for whatever context builders `pr-body.test.ts` already uses; reuse them rather than writing new ones, extending them with an override parameter if they lack one.)

- [ ] **Step 2: Run, expect FAIL** — `timeout 30 bun test test/unit/finish/pr-body.test.ts --timeout=5000`.

- [ ] **Step 3: Implement.** `buildAdvisorSection`'s `line`:

```ts
  const line = (d: AdviceDecision): string => {
    const acs = d.acceptanceChanges?.length ? ` — acceptance tests changed: ${flat(d.acceptanceChanges.join(", "))}` : "";
    return `- **${flat(d.id)}**${d.needsHumanConfirm ? " (needs confirmation)" : ""} ${flat(d.storyId ?? "feature")} · ${d.action.type} — ${flat(d.rationale)}${acs}`;
  };
```

`context.ts`: add `acceptanceGuard?: AcceptanceGuardRecord;` to the `unresolved` type, set `...(state.acceptanceGuard ? { acceptanceGuard: state.acceptanceGuard } : {})` in `fromResolution`, and include `state.acceptanceGuard !== undefined` in `needsBlock` so a ready PR still shows a revert.

`body.ts` `buildUnresolvedSection`, add to `checks`:

```ts
    ...(u.acceptanceGuard?.reverted.length ? [`- Acceptance-file edits reverted: ${flat(u.acceptanceGuard.reverted.join(", "))}`] : []),
    ...(u.acceptanceGuard?.beyondRuling.length
      ? [`- Acceptance tests changed beyond the ruling: ${flat(u.acceptanceGuard.beyondRuling.join(", "))}`]
      : []),
    ...(u.acceptanceGuard?.failed ? ["- acceptance-file check could not run"] : []),
```

- [ ] **Step 4: Run, expect PASS** — `timeout 30 bun test test/unit/finish/pr-body.test.ts test/unit/finish/pr-context.test.ts test/unit/finish/pr-body-ledger.test.ts --timeout=5000`.

- [ ] **Step 5: Commit** — `git commit -m "feat(finish): PR body shows ruling acceptance changes and guard actions"`

---

### Task 11: Full gates, coverage and docs

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-finish-b-rulings-stick-design.md` only if implementation diverged (add a short "Implementation notes" section; do not rewrite rulings)
- Modify: `docs/guides/` finish configuration guide only if it documents advisor behaviour that changed (grep `rg -l "dedupe" docs/guides`)

- [ ] **Step 1:** From `packages/nax`: `bun run test` → all green. Fix failures in the code, not by loosening tests.
- [ ] **Step 2:** From `packages/nax`: `bun run test:coverage` → passes; every new `src/` file at or above 80% lines and functions.
- [ ] **Step 3:** From the repo root: `bun run check:all` and `bun run typecheck` → green (file sizes, import cycles, cast ratchets, barrel rules).
- [ ] **Step 4:** Commit any doc touch-ups: `git commit -m "docs(finish): series B implementation notes"`.
- [ ] **Step 5 (needs approval at launch, not part of this plan's execution):** go-live = one live finish with the advisor on, on the next feature run that uses finish, via the local build in `repos/nax-run` after it is fast-forwarded (only when no run is using it). Billed.

---

## Self-review notes

- Spec coverage: §3.1-3.3 → Tasks 1-2; §3.4-3.6 → Tasks 3-4; §4.1-4.2 → Task 5; §5.1 → Task 6; §5.2 → Tasks 7-8; §5.3 → Task 8; §6.1-6.3 → Task 9; §6.4 → Tasks 7, 9, 10; §7 error handling → Task 4 (reconcile throw), Task 6 (missing file), Task 9 (`failed`); §8 tests → mapped per task; go-live → Task 11 Step 5.
- Known judgment calls an implementer may hit: the `advise.ts` ↔ `advise-rulings.ts` import cycle (Task 3 gives the leaf-module fallback); existing `FinishAdvisor` fakes in other tests need the two new members (Task 4 Step 4).
