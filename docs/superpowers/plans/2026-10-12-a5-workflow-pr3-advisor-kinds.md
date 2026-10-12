# A5 Workflow Mode — PR3 Advisor Kinds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR2's stubbed advisor with the real workflow kinds: an `implementer-question` answer, a batched `residual` ruling at the story cap (including `carry` into dependent stories), and a batched `preflight` that rules on spec/AC conflicts. Every ruling is a standard decision in `decisions.jsonl` and reaches the briefs it applies to.

**Architecture:**
- The advisor gains two actions (`answer`, `carry`), three question kinds (`implementer-question`, `residual`, `preflight`) and one entry point, `adviseBatch`. A batch is one op call (`adviseBatchOp`) whose reply carries one answer per item. Each answer is validated against its item's menu on its own, and each valid answer is written as a normal `AdviceDecision`.
- `src/workflow/advisor-live.ts` implements PR2's `WorkflowAdvisor` interface on top of the advisor, and `stage-env.ts` wires it in place of `defaultWorkflowAdvisor`.
- `src/workflow/preflight.ts` runs the pre-flight batch and writes `preflight.json`. `brief.ts` reads the trusted decisions and puts every pre-flight ruling and every carried instruction that applies to the story into its brief. Calling `runPreflight` at run start is PR4 (spec §12).

**Tech Stack:** TypeScript, Bun 1.4, bun:test.

**Spec:** `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md` (rev 2). This plan covers §8 and §12 PR3. Read §15 for the PR2 rulings this builds on.

**Plan series:** PR1 foundations (nax#2475) → PR2 story loop (nax#2476) → **PR3 advisor kinds (this plan)** → PR4 feature workflow.

## Rulings on the spec (made while planning, against the merged code)

| # | Ruling | Why |
|---|---|---|
| P3-R1 | `answer` and `carry` take their text from the reply's existing `instruction` field. `carry.toStories` is **fixed by the menu**: the story's not-yet-passed dependents. The carry option appears only when such dependents exist | It reuses the reply contract and validator unchanged. nax knows which stories depend on this one; the advisor can't aim an instruction at an unrelated story |
| P3-R2 | Pre-flight is **one** batch call in "discover" mode. The advisor lists the conflicts it finds, and each one is validated against the fixed four-option pre-flight menu built from that conflict's own AC and spec references. There is no separate scan call | One call, as spec §8 asks. The menu stays closed: nax builds it, the advisor only picks from it |
| P3-R3 | `adviseBatch` never writes a default decision. It returns a result per item (`decision` or `fallbackReason`), and the caller applies the kind's default (`hold`) | Only advisor-written lines reach `decisions.jsonl`, so `readTrustedDecisions` (audit-matched) keeps its meaning |
| P3-R4 | `AdviceDecision` gains an optional `appliesTo?: string[]`: a pre-flight conflict's story ids, or a carry's `toStories`. The brief selects rulings by it | One field answers "which briefs carry this ruling" for both kinds |
| P3-R5 | Batch calls are always stateless and walk the model ladder, whatever `advisor.memory` says. The single `implementer-question` goes through `advise()`, which honours `memory` (default `stateless`) | A warm session is bound to one model and one question chain (spec §8). A batch is a one-shot judgement |
| P3-R6 | `runPreflight` ships here and is tested directly. Calling it once before the first story is PR4's "pre-flight placement" | Spec §12 splits it that way |
| P3-R7 | A batch writes **one audit artifact per decision** (shared prompt, the item's own raw answer, its share of the cost) | `readTrustedDecisions` matches each ledger line to `advisor-audit/<feature>/<D-n>.json`; this keeps that check unchanged |
| P3-R8 | Residual gate diagnoses are free text. They return from the batch and go into the workflow ledger as today; they are not decisions | Spec §8: "a free-text diagnosis for each red gate"; a red gate stays red (D4) |
| P3-R9 | A workflow ruling's "cost if wrong" is derived from the reply: `<confidence> confidence; reversible` or `hard to undo`, plus `; needs confirmation` when flagged | The reply contract has no cost field; the skill's ledger line needs one |
| P3-R10 | PR2 carry-overs: the advisor-answer turn reuses the current round's model and time limit (PR2 final review M1); `adjudicateResidual` keeps the first ruling per finding and warns on duplicates and on rulings for unknown findings (PR2 T9) | Without M1, an answer would open a different session (the routed model) with no context once answers are real |

## Global Constraints

- Work in `packages/nax`; run commands from there. Never run bare `bun test` with no path, and never `bun run nax`.
- Single test file: `bun test <path> --timeout=60000`. Gate before push: package `bun run check:all` **and** repo-root `bun run check:all`, plus `bun run typecheck` and `bun run test:coverage`. Never `--update-baseline` on any ratchet.
- Source files ≤ 600 lines, test files ≤ 800 lines. `agents/manager.ts` and `session/manager.ts` must not grow. `advisor/service.ts` (389) may grow only by exports and small refactors; batch logic goes in `advisor/batch.ts`.
- Pipeline kinds (`finish-judgment`, `fix-cycle-give-up`, `uncategorised-failure`, `finish-approval`) keep their menus, prompts and behaviour byte-for-byte.
- Workflow kinds ignore `advisor.callers` and `maxRulingsPerStory`. `advisor.enabled` is already forced on in workflow mode (PR1).
- `src/operations` never imports values from `src/advisor` (type imports only), as today (`operations/advise.ts:41`).
- Only advisor-written decisions go to `decisions.jsonl`; every consumer reads through `readTrustedDecisions`.
- The PRD is never edited: amendments live in the ledger only (A1).
- Prompt text only in `src/prompts/builders/`, exported from `src/prompts/index.ts`. Every log call in `src/workflow/` and `src/advisor/` carries `storyId` (or `"_run"`) as the **first** data key.
- Tests: no `as never`, no `as unknown as`, no new single `as` casts beyond what the ratchet allows (looseCast must not exceed its baseline); no fixed sleeps; `_deps` injection, no `mock.module()`. Shared fakes go in `test/helpers/` and are exported from `@test/helpers`.
- Immutability: never mutate a decision, question, record or config; build new objects.
- Conventional commits (`feat:`, `test:`, `docs:`, `refactor:`). No emojis.

## Review Focus

1. **A batch reply that leaves out an item or picks an off-menu option for it.** That item alone falls to its default (`hold`); every other valid answer still becomes a decision. Pinned in Task 3.
2. **Every ladder model fails, or every model is in quota cooldown.** `adviseBatch` returns a `fallbackReason` for every item and never throws; the story still closes with default holds. Pinned in Task 3 and Task 4.
3. **A residual item whose story has no not-yet-passed dependents.** No carry option is offered; a reply that picks carry anyway is invalid and that item holds. Pinned in Task 1 and Task 4.
4. **A `decisions.jsonl` line with a malformed new action** (a `carry` without a `toStories` array, an `answer` without `text`). `parseLines` skips it with a warning, and briefs and PR bodies still render. Pinned in Task 1.
5. **A pre-flight reply with no conflicts, or one whose conflict cites a story id not in the PRD.** `preflight.json` is still written (empty conflicts, or the unknown id dropped with a warning) and no decision cites a story that doesn't exist. Pinned in Task 6.

---

### Task 1: Advisor types, menus, ledger parsing and renderers for the new kinds and actions

**Files:**
- Modify: `src/advisor/types.ts`, `src/advisor/menus.ts`, `src/advisor/ledger.ts` (`parseLines`), `src/advisor/heads-up.ts`
- Modify: `src/operations/advise.ts` (the `REQUIRED` mirror)
- Modify: `src/finish/pr/body.ts` (`buildAdvisorSection` line text)
- Test: `test/unit/advisor/menus-workflow-kinds.test.ts`, extend the existing ledger, heads-up and PR-body tests (find them with `grep -ln "buildAdvisorSection\|formatHeadsUp\|parseLines\|readDecisions" test/unit`)

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type AdviceQuestionKind =
    | "finish-judgment" | "fix-cycle-give-up" | "uncategorised-failure" | "finish-approval"
    | "preflight" | "implementer-question" | "residual";
  // AdviceAction gains:
  | { type: "answer"; text: string }
  | { type: "carry"; instruction: string; toStories: string[] }
  // AdviceOptionFixed gains:  toStories?: string[];
  // AdviceDecision gains:     appliesTo?: string[];
  // MenuFacts gains:
  | { kind: "implementer-question" }
  | { kind: "residual"; dependents: string[] }
  | { kind: "preflight"; acRef?: { storyId: string; acId: string }; specSection?: string }
  // menus.ts
  export const PREFLIGHT_OPTION_IDS = { followAc: "A", followSpec: "B", reconcile: "C", flag: "D" } as const;
  ```
  `REQUIRED_TEXT_FIELD.answer = "instruction"`, `REQUIRED_TEXT_FIELD.carry = "instruction"` (P3-R1).

- [ ] **Step 1: Write the failing tests**

`test/unit/advisor/menus-workflow-kinds.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildMenu, forcedConfirm, PREFLIGHT_OPTION_IDS, REQUIRED_TEXT_FIELD, toAction } from "@/advisor";
import type { AdvisorReply } from "@/advisor";

const reply = (over: Partial<AdvisorReply> = {}): AdvisorReply => ({
  optionId: "A",
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  ...over,
});

describe("implementer-question menu", () => {
  test("answer or hold", () => {
    const menu = buildMenu({ kind: "implementer-question" });
    expect(menu.map((o) => [o.id, o.type])).toEqual([
      ["A", "answer"],
      ["B", "hold"],
    ]);
  });

  test("answer takes its text from instruction", () => {
    const [answer] = buildMenu({ kind: "implementer-question" });
    expect(REQUIRED_TEXT_FIELD.answer).toBe("instruction");
    expect(toAction(answer, reply({ instruction: "Use the tenant id from the JWT." }))).toEqual({
      type: "answer",
      text: "Use the tenant id from the JWT.",
    });
  });
});

describe("residual menu", () => {
  test("carry appears only with dependents, with toStories fixed by the menu (P3-R1)", () => {
    const withDeps = buildMenu({ kind: "residual", dependents: ["US-004", "US-005"] });
    expect(withDeps.map((o) => o.type)).toEqual(["waive", "defer", "carry", "hold"]);
    const carry = withDeps.find((o) => o.type === "carry");
    expect(carry?.fixed?.toStories).toEqual(["US-004", "US-005"]);
    expect(carry?.label).toContain("US-004, US-005");
    expect(buildMenu({ kind: "residual", dependents: [] }).map((o) => o.type)).toEqual(["waive", "defer", "hold"]);
  });

  test("carry action carries the instruction and the menu's stories", () => {
    const carry = buildMenu({ kind: "residual", dependents: ["US-004"] }).find((o) => o.type === "carry");
    if (!carry) throw new Error("no carry option");
    expect(toAction(carry, reply({ optionId: carry.id, instruction: "Keep the lock order." }))).toEqual({
      type: "carry",
      instruction: "Keep the lock order.",
      toStories: ["US-004"],
    });
  });

  test("carry is not force-flagged; hold still is", () => {
    const carry = { type: "carry" as const, instruction: "x", toStories: ["US-4"] };
    expect(forcedConfirm(carry, reply())).toBe(false);
    expect(forcedConfirm({ type: "hold", reason: "x" }, reply())).toBe(true);
  });
});

describe("preflight menu", () => {
  test("fixed ids A-D; options missing a reference are omitted without shifting ids", () => {
    const both = buildMenu({ kind: "preflight", acRef: { storyId: "US-2", acId: "AC-3" }, specSection: "4.1" });
    expect(both.map((o) => [o.id, o.type])).toEqual([
      [PREFLIGHT_OPTION_IDS.followAc, "supersede"],
      [PREFLIGHT_OPTION_IDS.followSpec, "supersede"],
      [PREFLIGHT_OPTION_IDS.reconcile, "supersede"],
      [PREFLIGHT_OPTION_IDS.flag, "hold"],
    ]);
    expect(both[0]?.fixed?.target).toEqual({ kind: "spec", section: "4.1" });
    expect(both[1]?.fixed?.target).toEqual({ kind: "ac", storyId: "US-2", acId: "AC-3" });

    const specOnly = buildMenu({ kind: "preflight", specSection: "4.1" });
    expect(specOnly.map((o) => o.id)).toEqual(["A", "D"]);
    const acOnly = buildMenu({ kind: "preflight", acRef: { storyId: "US-2", acId: "AC-3" } });
    expect(acOnly.map((o) => o.id)).toEqual(["B", "C", "D"]);
  });
});

describe("pipeline menus unchanged", () => {
  test("finish-approval still approve / re-review / hold", () => {
    const menu = buildMenu({
      kind: "finish-approval",
      allPhasesComplete: true,
      gatesGreen: true,
      reReviewUsed: false,
      reReviewPhase: "quality",
    });
    expect(menu.map((o) => [o.id, o.type])).toEqual([
      ["A", "approve"],
      ["B", "re-review"],
      ["C", "hold"],
    ]);
  });
});
```

Add to the existing ledger test file (Review Focus 4):
```ts
test("parseLines skips a carry without toStories and an answer without text", async () => {
  // write three lines through the _ledgerDeps.readText seam the file's other tests use:
  // one valid carry, one carry with toStories missing, one answer with text missing.
  // Expect readDecisions to return only the valid carry, and a warn log per skipped line.
});
```
Write it out in the file's own fixture style (it already fakes `_ledgerDeps.readText`): build each line with `JSON.stringify({...decisionFixture, id: "D-n", action: ...})`, and assert `(await readDecisions(root, "f")).map((d) => d.id)` equals `["D-1"]`.

Add to the PR-body test file:
```ts
test("advisor section renders answer and carry", () => {
  // decisions: D-1 { action: { type: "carry", instruction: "Keep lock order", toStories: ["US-4", "US-5"] } },
  //            D-2 { action: { type: "answer", text: "Use Postgres" } }
  // expect the section to contain "carry → US-4, US-5 — Keep lock order" and "answer — Use Postgres"
});
```
Again in the file's own fixture style, with real assertions on the rendered string.

Add to the heads-up test file: `formatHeadsUp` for a carry decision contains `Chose: carry (to US-4)`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/advisor/menus-workflow-kinds.test.ts --timeout=60000` (plus the three extended files)
Expected: FAIL (type errors / missing exports / wrong output).

- [ ] **Step 3: Implement**

`src/advisor/types.ts`: apply the type changes in **Interfaces**. In `AdviceDecision`, add after `acceptanceChanges`:
```ts
  /** A5 PR3: the stories this ruling applies to (pre-flight conflict stories, or a carry's toStories). */
  appliesTo?: string[];
```

`src/advisor/menus.ts`:
```ts
// LABELS: add
  answer: "Answer the implementer's question (put the answer in instruction)",
  carry: "Load-bearing: carry an instruction into the dependent stories",
// REQUIRED_TEXT_FIELD: add
  answer: "instruction",
  carry: "instruction",

type Draft = { type: AdviceActionType; fixed?: AdviceOptionFixed; label?: string; id?: string };

function withIds(drafts: readonly Draft[]): AdviceOption[] {
  return drafts.map((d, i) => ({
    id: d.id ?? OPTION_IDS[i] ?? String(i),
    type: d.type,
    label: d.label ?? LABELS[d.type],
    ...(d.fixed ? { fixed: d.fixed } : {}),
  }));
}

export const PREFLIGHT_OPTION_IDS = { followAc: "A", followSpec: "B", reconcile: "C", flag: "D" } as const;

function preflightDrafts(f: Extract<MenuFacts, { kind: "preflight" }>): Draft[] {
  const followAc: Draft[] = f.specSection
    ? [
        {
          id: PREFLIGHT_OPTION_IDS.followAc,
          type: "supersede",
          fixed: { target: { kind: "spec", section: f.specSection } },
          label: "Follow the AC: supersede the spec section (give the corrected spec text)",
        },
      ]
    : [];
  const acTarget = f.acRef ? { target: { kind: "ac" as const, ...f.acRef } } : undefined;
  const onAc: Draft[] = acTarget
    ? [
        {
          id: PREFLIGHT_OPTION_IDS.followSpec,
          type: "supersede",
          fixed: acTarget,
          label: "Follow the spec: supersede the AC (give the corrected AC text)",
        },
        {
          id: PREFLIGHT_OPTION_IDS.reconcile,
          type: "supersede",
          fixed: acTarget,
          label: "Reconcile: rewrite the AC so it satisfies both (give the text)",
        },
      ]
    : [];
  return [
    ...followAc,
    ...onAc,
    {
      id: PREFLIGHT_OPTION_IDS.flag,
      type: "hold",
      label: "Flag for a human: the story runs under a stated default (put the default in reason)",
    },
  ];
}

// buildMenu: add cases
    case "implementer-question":
      return withIds([
        { type: "answer" },
        { type: "hold", label: "No answer: the implementer goes on to review with its concern" },
      ]);
    case "residual":
      return withIds([
        { type: "waive", label: "Park: the reviewer is wrong (say why in reason)" },
        { type: "defer", label: "Park: real, but defer it to the branch review (say why in reason)" },
        ...(facts.dependents.length > 0
          ? [
              {
                type: "carry" as const,
                fixed: { toStories: facts.dependents },
                label: `Load-bearing: carry an instruction into ${facts.dependents.join(", ")}`,
              },
            ]
          : []),
        { type: "hold", label: "Flag for a human" },
      ]);
    case "preflight":
      return withIds(preflightDrafts(facts));

// toAction: add cases
    case "answer":
      return { type: "answer", text: text("instruction") };
    case "carry":
      return { type: "carry", instruction: text("instruction"), toStories: option.fixed?.toStories ?? [] };
```
`forcedConfirm` needs no change: `carry` and `answer` aren't in its forced list.

`src/advisor/index.ts`: add `PREFLIGHT_OPTION_IDS` to the `./menus` export line.

`src/operations/advise.ts`: add `answer: "instruction"` and `carry: "instruction"` to the `REQUIRED` mirror.

`src/advisor/ledger.ts` `parseLines`: a line counts only if it has a string `id` and a well-formed action. Replace the object check with:
```ts
function isWellFormedAction(a: unknown): boolean {
  if (typeof a !== "object" || a === null) return false;
  const action = a as { type?: unknown; toStories?: unknown; text?: unknown; instruction?: unknown };
  if (typeof action.type !== "string") return false;
  if (action.type === "carry") {
    return typeof action.instruction === "string" && Array.isArray(action.toStories) &&
      action.toStories.every((s) => typeof s === "string");
  }
  if (action.type === "answer") return typeof action.text === "string";
  return true;
}
```
and push only when `typeof parsed.id === "string" && isWellFormedAction(parsed.action)`; otherwise keep the existing "not a decision" warning.

`src/advisor/heads-up.ts`: replace `` `Chose: ${d.action.type}` `` with `` `Chose: ${d.action.type}${d.action.type === "carry" ? ` (to ${d.action.toStories.join(", ")})` : ""}` ``.

`src/finish/pr/body.ts` `buildAdvisorSection`: let the line show what the ruling says for the new actions:
```ts
  const detail = (d: AdviceDecision): string => {
    if (d.action.type === "carry") return `carry → ${flat(d.action.toStories.join(", "))} — ${flat(d.action.instruction)}`;
    if (d.action.type === "answer") return `answer — ${flat(d.action.text)}`;
    return `${d.action.type} — ${flat(d.rationale)}`;
  };
  // the line becomes:
  return `- **${flat(d.id)}**${d.needsHumanConfirm ? " (needs confirmation)" : ""} ${flat(d.storyId ?? "feature")} · ${detail(d)}${acs}`;
```
Every other action type renders as before.

Exhaustive `Record<AdviceActionType, …>` maps or `switch` statements elsewhere fail typecheck until they handle the two new types. Fix each one `bun run typecheck` reports, keeping today's behaviour for pipeline callers (`default: return null` where one exists already).

- [ ] **Step 4: Run them to verify they pass**

Run: the four test files, then `bun test test/unit/advisor --timeout=60000`, then `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/advisor src/operations/advise.ts src/finish/pr/body.ts test/unit
git commit -m "feat(advisor): answer/carry actions and workflow question kinds (menus, ledger, renderers)"
```

---

### Task 2: Batch prompt builder and `adviseBatchOp`

**Files:**
- Modify: `src/prompts/builders/advisor-builder.ts` (export the shared blocks)
- Create: `src/prompts/builders/advisor-batch-builder.ts`
- Modify: `src/prompts/index.ts`
- Create: `src/operations/advise-batch.ts`; Modify: `src/operations/index.ts`
- Test: `test/unit/prompts/advisor-batch-builder.test.ts`, `test/unit/operations/advise-batch.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `validateAdvisorReply` (`operations/advise.ts`).
- Produces:
  ```ts
  // prompts
  export const ADVISOR_ROLE: string; export const ADVISOR_POLICY: string;
  export function advisorDecisionsBlock(d: readonly AdviceDecision[]): string;
  export function advisorQuestionBlock(q: AdviceQuestion): string;
  export interface AdvisorBatchPromptInput {
    readonly kind: "residual" | "preflight";
    readonly summary: string;
    readonly items: readonly AdviceQuestion[];       // residual; [] for preflight
    readonly redGates: readonly string[];            // residual
    readonly storyIds: readonly string[];            // preflight: the PRD's story ids
    readonly specPath: string;
    readonly prdText: string;
    readonly priorDecisions: readonly AdviceDecision[];
  }
  export function buildAdvisorBatchPrompt(input: AdvisorBatchPromptInput): string;
  // operations/advise-batch.ts
  export interface AdviseBatchOpInput extends AdvisorBatchPromptInput { readonly model?: ConfiguredModel; readonly timeoutMs?: number }
  export interface BatchItemAnswer { readonly itemId: string; readonly reply?: AdvisorReply; readonly error?: string; readonly raw: unknown }
  export interface RawPreflightConflict {
    readonly storyIds: readonly string[];
    readonly acRef?: { readonly storyId: string; readonly acId: string };
    readonly specSection?: string;
    readonly description: string;
    readonly raw: Record<string, unknown>;          // the reply fields, validated later against the built menu
  }
  export type AdviseBatchOpOutput =
    | { ok: true; answers: readonly BatchItemAnswer[]; diagnoses: Readonly<Record<string, string>>;
        conflicts: readonly RawPreflightConflict[];
        overlap: readonly { readonly storyId: string; readonly specSections: readonly string[] }[] }
    | { ok: false; error: string; preview: string };
  export const adviseBatchOp: RunOperation<AdviseBatchOpInput, AdviseBatchOpOutput, AdvisorConfigSlice>;
  ```
  Rules: `ok: false` only when the reply has no JSON object. For residual, every item gets a `BatchItemAnswer`: a missing answer gives `error: "no answer for this item"`; an invalid one gives the validator's error. For pre-flight, conflicts missing `description` or with neither `acRef` nor `specSection` are dropped; menu validation of a conflict happens later in Task 3 (operations can't import `buildMenu`).

- [ ] **Step 1: Write the failing tests**

`test/unit/prompts/advisor-batch-builder.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildAdvisorBatchPrompt } from "@/prompts";
import type { AdviceQuestion } from "@/advisor";

const item: AdviceQuestion = {
  id: "Q-1",
  kind: "residual",
  feature: "f",
  storyId: "US-3",
  askedAtSha: "abc",
  summary: "AC-2 untested",
  evidence: [{ source: "finding", ref: "F2", text: "AC-2 has no test" }],
  options: [
    { id: "A", type: "waive", label: "Park: the reviewer is wrong" },
    { id: "D", type: "hold", label: "Flag" },
  ],
};
const base = { specPath: "spec.md", prdText: "{}", priorDecisions: [] };

describe("buildAdvisorBatchPrompt", () => {
  test("residual: every item with its own menu, the gates to diagnose, and the answers contract", () => {
    const text = buildAdvisorBatchPrompt({ ...base, kind: "residual", summary: "US-3 hit its cap", items: [item], redGates: ["full-suite"], storyIds: [] });
    for (const needle of ["Q-1", "AC-2 untested", "A. [waive]", "full-suite", '"answers"', '"itemId"', '"diagnoses"', "Decision policy"]) {
      expect(text).toContain(needle);
    }
  });

  test("preflight: the four fixed options, the overlap table and the conflicts contract", () => {
    const text = buildAdvisorBatchPrompt({ ...base, kind: "preflight", summary: "pre-flight", items: [], redGates: [], storyIds: ["US-1", "US-2"] });
    for (const needle of ['"overlap"', '"conflicts"', '"acRef"', '"specSection"', "A —", "B —", "C —", "D —", "US-1, US-2"]) {
      expect(text).toContain(needle);
    }
  });
});
```

`test/unit/operations/advise-batch.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { adviseBatchOp } from "@/operations";
import type { AdviceQuestion } from "@/advisor";
import { makeNaxConfig, makeTestRuntime, opSelector } from "@test/helpers";
import { advisorConfigSelector } from "@/config";

const q = (id: string): AdviceQuestion => ({
  id,
  kind: "residual",
  feature: "f",
  storyId: "US-3",
  askedAtSha: "abc",
  summary: id,
  evidence: [],
  options: [
    { id: "A", type: "waive", label: "w" },
    { id: "B", type: "hold", label: "h" },
  ],
});
const input = {
  kind: "residual" as const,
  summary: "s",
  items: [q("Q-1"), q("Q-2"), q("Q-3")],
  redGates: ["lint"],
  storyIds: [],
  specPath: "spec.md",
  prdText: "{}",
  priorDecisions: [],
};
const ctx = (() => {
  const config = makeNaxConfig({});
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(advisorConfigSelector)) };
})();
const ok = { rationale: "r", confidence: "high", reversible: true, needsHumanConfirm: false };

describe("adviseBatchOp.parse", () => {
  test("validates each answer on its own (Review Focus 1)", () => {
    const out = adviseBatchOp.parse(
      JSON.stringify({
        answers: [
          { itemId: "Q-1", optionId: "A", reason: "spec 3.2 allows it", ...ok },
          { itemId: "Q-2", optionId: "Z", ...ok },
        ],
        diagnoses: { lint: "biome config drift" },
      }),
      input,
      ctx,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.answers.map((a) => [a.itemId, a.reply?.optionId ?? null, a.error ?? null])).toEqual([
      ["Q-1", "A", null],
      ["Q-2", null, "optionId Z is not on the menu"],
      ["Q-3", null, "no answer for this item"],
    ]);
    expect(out.diagnoses).toEqual({ lint: "biome config drift" });
  });

  test("no JSON at all -> ok:false", () => {
    expect(adviseBatchOp.parse("I think we should hold.", input, ctx).ok).toBe(false);
  });

  test("preflight: keeps well-formed conflicts and the overlap table, drops unusable ones", () => {
    const out = adviseBatchOp.parse(
      JSON.stringify({
        overlap: [{ storyId: "US-1", specSections: ["3.2"] }],
        conflicts: [
          { storyIds: ["US-2"], acRef: { storyId: "US-2", acId: "AC-3" }, specSection: "4.1", description: "AC-3 says 30d, spec says 14d", optionId: "B", newText: "14 days", ...ok },
          { storyIds: ["US-2"], description: "no refs" },
          { storyIds: ["US-2"], specSection: "4.1" },
        ],
      }),
      { ...input, kind: "preflight", items: [], redGates: [], storyIds: ["US-1", "US-2"] },
      ctx,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.overlap).toEqual([{ storyId: "US-1", specSections: ["3.2"] }]);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.description).toBe("AC-3 says 30d, spec says 14d");
  });

  test("shape: fresh advisor session, read-only tools", () => {
    expect(adviseBatchOp.session).toEqual({ role: "advisor", lifetime: "fresh" });
    expect(adviseBatchOp.tools).toEqual(["Read", "Glob", "Grep"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/prompts/advisor-batch-builder.test.ts test/unit/operations/advise-batch.test.ts --timeout=60000`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

`src/prompts/builders/advisor-builder.ts`: rename `ROLE` → `ADVISOR_ROLE`, `POLICY` → `ADVISOR_POLICY`, `decisionsBlock` → `advisorDecisionsBlock`, `questionBlock` → `advisorQuestionBlock`, and export all four. `buildAdvisorPrompt`'s output must stay byte-for-byte identical; its existing tests prove that.

`src/prompts/builders/advisor-batch-builder.ts`:
```ts
/** A5 PR3: the batched advisor prompt (spec §8) — one call, one answer per item. */
import type { AdviceDecision, AdviceQuestion } from "@/advisor/types";
import { ADVISOR_POLICY, ADVISOR_ROLE, advisorDecisionsBlock, advisorQuestionBlock } from "./advisor-builder";

export interface AdvisorBatchPromptInput {
  readonly kind: "residual" | "preflight";
  readonly summary: string;
  readonly items: readonly AdviceQuestion[];
  readonly redGates: readonly string[];
  readonly storyIds: readonly string[];
  readonly specPath: string;
  readonly prdText: string;
  readonly priorDecisions: readonly AdviceDecision[];
}

const ANSWER_FIELDS = `"optionId": "A", "instruction": "...", "reason": "...", "newText": "...", "rationale": "...", "confidence": "high|medium|low", "reversible": true, "needsHumanConfirm": false`;

function residualBlock(input: AdvisorBatchPromptInput): string {
  const items = input.items.map(advisorQuestionBlock).join("\n\n");
  const gates =
    input.redGates.length > 0
      ? `\n\n## Red gates to diagnose\n${input.redGates.map((g) => `- ${g}`).join("\n")}\nA red gate stays red whatever you rule. Give a short diagnosis for each in "diagnoses".`
      : "";
  return `## The story reached its fix-round cap\n${input.summary}\n\nRule on each open item below. Park an item when the reviewer is wrong (waive) or when it is real but can wait for the branch review (defer). Choose carry only when a later story must act on it, and say exactly what that story must do.\n\n${items}${gates}

## Reply
End your reply with exactly one fenced JSON block, one answer per item id:
\`\`\`json
{"answers": [{"itemId": "Q-...", ${ANSWER_FIELDS}}], "diagnoses": {"<gate>": "..."}}
\`\`\`
Include "instruction" for carry, "reason" for waive/defer/hold. "rationale" is always required.`;
}

function preflightBlock(input: AdvisorBatchPromptInput): string {
  return `## Pre-flight
${input.summary}

Before the first story runs, compare every story's acceptance criteria (AC) with the spec. Stories: ${input.storyIds.join(", ")}.
1. Build an overlap table: for each story, the spec sections that govern it.
2. List every conflict: an AC that contradicts the spec, or two ACs that contradict each other. Cite the AC as {"storyId", "acId"} (AC ids are AC-1, AC-2, … in PRD order) and the spec section by its heading number or title.
3. Rule on each conflict with exactly one option:
   A — follow the AC: the spec section is superseded (give the corrected spec text in newText; needs specSection)
   B — follow the spec: the AC is superseded (give the corrected AC text in newText; needs acRef)
   C — reconcile: rewrite the AC so it satisfies both (newText; needs acRef)
   D — flag for a human: the story runs under a stated default (put the default in reason)
List no conflict you are not sure of. An empty list is a valid answer.

## Reply
End your reply with exactly one fenced JSON block:
\`\`\`json
{"overlap": [{"storyId": "US-001", "specSections": ["3.2"]}], "conflicts": [{"storyIds": ["US-002"], "acRef": {"storyId": "US-002", "acId": "AC-3"}, "specSection": "4.1", "description": "...", ${ANSWER_FIELDS}}]}
\`\`\``;
}

export function buildAdvisorBatchPrompt(input: AdvisorBatchPromptInput): string {
  return [
    ADVISOR_ROLE,
    ADVISOR_POLICY,
    `## Feature\nSpec: ${input.specPath} (read it as needed)\n\nPRD:\n${input.prdText}`,
    advisorDecisionsBlock(input.priorDecisions),
    input.kind === "residual" ? residualBlock(input) : preflightBlock(input),
  ].join("\n\n");
}
```
Export `buildAdvisorBatchPrompt` and `AdvisorBatchPromptInput` from `src/prompts/index.ts`.

`src/operations/advise-batch.ts`:
```ts
/**
 * A5 PR3: one advisor call that rules on N items (spec §8 "Batched questions"). Each residual
 * answer is validated against its own item's menu; pre-flight conflicts are validated later,
 * against the menu the advisor service builds from each conflict's references (P3-R2).
 */
import type { AdvisorReply } from "../advisor/types";
import { previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry/parse-retry";
import type { ConfiguredModel } from "../config";
import { advisorConfigSelector, resolveAdvisorConfig } from "../config";
import type { AdvisorConfigSlice } from "../config/selectors";
import { type AdvisorBatchPromptInput, buildAdvisorBatchPrompt } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import { validateAdvisorReply } from "./advise";
import type { RunOperation } from "./types";

// AdviseBatchOpInput, BatchItemAnswer, RawPreflightConflict, AdviseBatchOpOutput exactly as in Interfaces.

const NO_ANSWER = "no answer for this item";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
}

function residualAnswers(parsed: Record<string, unknown>, input: AdviseBatchOpInput): BatchItemAnswer[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const a of Array.isArray(parsed.answers) ? parsed.answers : []) {
    if (isRecord(a) && typeof a.itemId === "string" && !byId.has(a.itemId)) byId.set(a.itemId, a);
  }
  return input.items.map((item): BatchItemAnswer => {
    const raw = byId.get(item.id);
    if (!raw) return { itemId: item.id, error: NO_ANSWER, raw: null };
    const checked = validateAdvisorReply(raw, item.options);
    return checked.ok ? { itemId: item.id, reply: checked.reply, raw } : { itemId: item.id, error: checked.error, raw };
  });
}

function diagnoses(parsed: Record<string, unknown>, gates: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(parsed.diagnoses)) return out;
  for (const gate of gates) {
    const text = parsed.diagnoses[gate];
    if (typeof text === "string" && text.trim() !== "") out[gate] = text;
  }
  return out;
}

function acRefOf(v: unknown): { storyId: string; acId: string } | undefined {
  return isRecord(v) && typeof v.storyId === "string" && typeof v.acId === "string"
    ? { storyId: v.storyId, acId: v.acId }
    : undefined;
}

function conflicts(parsed: Record<string, unknown>): RawPreflightConflict[] {
  const out: RawPreflightConflict[] = [];
  for (const c of Array.isArray(parsed.conflicts) ? parsed.conflicts : []) {
    if (!isRecord(c) || typeof c.description !== "string" || c.description.trim() === "") continue;
    const acRef = acRefOf(c.acRef);
    const specSection = typeof c.specSection === "string" && c.specSection.trim() !== "" ? c.specSection : undefined;
    if (!acRef && !specSection) continue;
    out.push({
      storyIds: strings(c.storyIds),
      ...(acRef ? { acRef } : {}),
      ...(specSection ? { specSection } : {}),
      description: c.description,
      raw: c,
    });
  }
  return out;
}

function overlap(parsed: Record<string, unknown>): { storyId: string; specSections: string[] }[] {
  return (Array.isArray(parsed.overlap) ? parsed.overlap : [])
    .filter(isRecord)
    .filter((o) => typeof o.storyId === "string")
    .map((o) => ({ storyId: o.storyId as string, specSections: strings(o.specSections) }));
}

export const adviseBatchOp: RunOperation<AdviseBatchOpInput, AdviseBatchOpOutput, AdvisorConfigSlice> = {
  kind: "run",
  name: "advise-batch",
  stage: "review",
  session: { role: "advisor", lifetime: "fresh" },
  tools: ["Read", "Glob", "Grep"],
  config: advisorConfigSelector,
  model: (input, ctx) => input.model ?? resolveAdvisorConfig(ctx.config).model,
  timeoutMs: (input, ctx) =>
    input.timeoutMs ?? resolveAdvisorConfig(ctx.config).timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildAdvisorBatchPrompt(input), overridable: false },
  }),
  parse: (output, input) => {
    const parsed = tryParseLLMJson<unknown>(output);
    if (!isRecord(parsed)) {
      const preview = previewOutput(output, UNPARSED_PREVIEW_BYTES);
      return { ok: false, error: "no-json", preview: preview === "" ? "(empty response)" : preview };
    }
    return {
      ok: true,
      answers: input.kind === "residual" ? residualAnswers(parsed, input) : [],
      diagnoses: input.kind === "residual" ? diagnoses(parsed, input.redGates) : {},
      conflicts: input.kind === "preflight" ? conflicts(parsed) : [],
      overlap: input.kind === "preflight" ? overlap(parsed) : [],
    };
  },
};
```
`AdviseBatchOpInput extends AdvisorBatchPromptInput` uses a type-only import from `../prompts`. If the barrel import cycles, import the type from the builder's leaf path. Export `adviseBatchOp` and its types from `src/operations/index.ts`.

- [ ] **Step 4: Run them to verify they pass**

Run: both test files and the existing advisor-builder tests (`grep -ln "buildAdvisorPrompt" test/unit`), then `bun run typecheck`
Expected: PASS, with `buildAdvisorPrompt` output unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/prompts src/operations test/unit
git commit -m "feat(advisor): batched advisor prompt and adviseBatchOp (residual answers, pre-flight conflicts)"
```

---

### Task 3: `adviseBatch` in the advisor service

**Files:**
- Modify: `src/advisor/ladder.ts` (shared ladder selection), `src/advisor/service.ts` (export helpers, use the shared ladder, add `adviseBatch` to `Advisor`)
- Create: `src/advisor/batch.ts`; Modify: `src/advisor/index.ts`
- Test: `test/unit/advisor/batch.test.ts`

**Interfaces:**
- Consumes: Task 1 (`buildMenu`, `toAction`, new types), Task 2 (`adviseBatchOp`, `validateAdvisorReply`).
- Produces:
  ```ts
  // ladder.ts
  export function ladderModels(config: AdvisorConfig, isCooling: (m: ConfiguredModel) => boolean): ConfiguredModel[];
  //   usable models, or the whole ladder when every entry is cooling (today's runLadder rule)
  // batch.ts
  export type BatchRequest =
    | { kind: "residual"; storyId: string; summary: string; items: QuestionDraft[]; redGates: string[] }
    | { kind: "preflight"; summary: string; storyIds: string[] };
  export interface BatchItemResult { question: AdviceQuestion; decision: AdviceDecision | null; fallbackReason?: string }
  export type BatchResult =
    | { kind: "residual"; items: BatchItemResult[]; diagnoses: Record<string, string>; fallbackReason?: string }
    | { kind: "preflight"; items: BatchItemResult[]; overlap: { storyId: string; specSections: string[] }[];
        fallbackReason?: string };
  export async function adviseBatch(actx: AdvisorCallContext, req: BatchRequest): Promise<BatchResult>;
  // service.ts: Advisor gains
  adviseBatch(req: BatchRequest): Promise<BatchResult>;
  ```
  Rules:
  - One worktree snapshot and one trusted-decisions read per batch. Stateless ladder (P3-R5). The next model is tried when the op throws or returns `ok: false`.
  - Residual: each item becomes an `AdviceQuestion` (new id, the batch's `askedAtSha`). Pre-flight: each kept conflict becomes `{ kind: "preflight", storyId: storyIds[0], summary: description, evidence, options: buildMenu({ kind: "preflight", acRef, specSection }) }`, and its raw reply is validated against that menu.
  - A valid answer is appended with `appendDecision`, carrying `appliesTo` (pre-flight: the conflict's story ids; carry: `toStories`; otherwise absent) and the same fields `advise()` writes (`forcedConfirm`, model, `auditRef`).
  - Pre-flight story ids not in `req.storyIds` are dropped with a warning (Review Focus 5); a conflict left with none is dropped.
  - One audit artifact per item (P3-R7). Cost is the batch's cost split evenly across items.
  - Flagged decisions get a heads-up through the same channel as `advise()`.
  - Nothing throws. Any error becomes `fallbackReason` on the result and on every item (P3-R3).

- [ ] **Step 1: Write the failing test**

`test/unit/advisor/batch.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { _advisorServiceDeps, adviseBatch, buildMenu, readDecisions } from "@/advisor";
import type { AdvisorCallContext } from "@/advisor";
import { adviseBatchOp } from "@/operations";
import { cleanupTempDir, makeMockCallContext, makeNaxConfig, makeTempDir, makeTestRuntime } from "@test/helpers";

const original = { ..._advisorServiceDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_advisorServiceDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function setup(fallbackModels: string[] = []): AdvisorCallContext {
  const root = makeTempDir("adv-batch-");
  dirs.push(root);
  const config = makeNaxConfig({ advisor: { enabled: true, model: "powerful", fallbackModels } });
  const runtime = makeTestRuntime({ config });
  _advisorServiceDeps.captureWorktreePatch = async () => ({ sha: "abc", patch: "", patchTruncated: false });
  _advisorServiceDeps.readPrdText = async () => "{}";
  return {
    callCtx: makeMockCallContext({ runtime, config }),
    repoRoot: root,
    outputDir: join(root, "out"),
    feature: "f",
    runId: "r",
    specPath: "spec.md",
    workdir: root,
  };
}

const residual = (n: number) => ({
  kind: "residual" as const,
  storyId: "US-3",
  summary: "cap",
  redGates: ["full-suite"],
  items: Array.from({ length: n }, (_, i) => ({
    kind: "residual" as const,
    feature: "f",
    storyId: "US-3",
    summary: `F${i + 1}`,
    evidence: [],
    options: buildMenu({ kind: "residual", dependents: ["US-4"] }),
  })),
});
const ok = { rationale: "r", confidence: "high" as const, reversible: true, needsHumanConfirm: false };

describe("adviseBatch residual", () => {
  test("valid answers become decisions; a missing or invalid one falls back alone (Review Focus 1)", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async (_c: unknown, op: { name: string }, input: { items: { id: string }[] }) => {
      expect(op.name).toBe(adviseBatchOp.name);
      const [a, b] = input.items;
      return {
        ok: true,
        answers: [
          { itemId: a?.id, reply: { optionId: "C", instruction: "Keep lock order", ...ok }, raw: {} },
          { itemId: b?.id, error: "optionId Z is not on the menu", raw: {} },
          { itemId: input.items[2]?.id, error: "no answer for this item", raw: null },
        ],
        diagnoses: { "full-suite": "port clash" },
        conflicts: [],
        overlap: [],
      };
    }) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, residual(3));
    if (out.kind !== "residual") throw new Error("kind");
    expect(out.items.map((i) => i.decision?.action.type ?? null)).toEqual(["carry", null, null]);
    expect(out.items[0]?.decision?.appliesTo).toEqual(["US-4"]);
    expect(out.items[1]?.fallbackReason).toContain("not on the menu");
    expect(out.diagnoses).toEqual({ "full-suite": "port clash" });
    expect((await readDecisions(actx.repoRoot, "f")).map((d) => d.kind)).toEqual(["residual"]);
    expect(await Bun.file(join(actx.outputDir, "advisor-audit", "f", "D-1.json")).exists()).toBe(true);
  });

  test("every ladder model fails -> every item falls back, no throw, no decisions (Review Focus 2)", async () => {
    const actx = setup(["balanced"]);
    const tried: unknown[] = [];
    _advisorServiceDeps.callOp = (async (_c: unknown, _op: unknown, input: { model?: unknown }) => {
      tried.push(input.model);
      throw new Error("429 usage limit reached");
    }) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, residual(2));
    expect(tried).toEqual(["powerful", "balanced"]);
    expect(out.items.every((i) => i.decision === null && (i.fallbackReason ?? "").includes("usage limit"))).toBe(true);
    expect(await readDecisions(actx.repoRoot, "f")).toEqual([]);
  });

  test("ok:false from the op tries the next model", async () => {
    const actx = setup(["balanced"]);
    let n = 0;
    _advisorServiceDeps.callOp = (async (_c: unknown, _op: unknown, input: { items: { id: string }[] }) => {
      n += 1;
      if (n === 1) return { ok: false, error: "no-json", preview: "" };
      return {
        ok: true,
        answers: input.items.map((it) => ({ itemId: it.id, reply: { optionId: "A", reason: "spec allows", ...ok }, raw: {} })),
        diagnoses: {},
        conflicts: [],
        overlap: [],
      };
    }) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, residual(1));
    expect(out.items[0]?.decision?.action.type).toBe("waive");
    expect(out.items[0]?.decision?.model).toBe("balanced");
  });
});

describe("adviseBatch preflight", () => {
  test("conflicts validated against the built menu; appliesTo = known story ids (Review Focus 5)", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async () => ({
      ok: true,
      answers: [],
      diagnoses: {},
      overlap: [{ storyId: "US-1", specSections: ["3.2"] }],
      conflicts: [
        { storyIds: ["US-2", "US-9"], acRef: { storyId: "US-2", acId: "AC-3" }, specSection: "4.1", description: "30d vs 14d",
          raw: { optionId: "B", newText: "14 days", ...ok } },
        { storyIds: ["US-2"], specSection: "4.1", description: "spec-only conflict", raw: { optionId: "B", newText: "x", ...ok } },
        { storyIds: ["US-9"], specSection: "5", description: "unknown story only", raw: { optionId: "A", newText: "y", ...ok } },
      ],
    })) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, { kind: "preflight", summary: "pf", storyIds: ["US-1", "US-2"] });
    if (out.kind !== "preflight") throw new Error("kind");
    expect(out.overlap).toEqual([{ storyId: "US-1", specSections: ["3.2"] }]);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]?.decision?.action).toEqual({ type: "supersede", target: { kind: "ac", storyId: "US-2", acId: "AC-3" }, newText: "14 days" });
    expect(out.items[0]?.decision?.appliesTo).toEqual(["US-2"]);
    expect(out.items[1]?.decision).toBeNull(); // option B needs an acRef the conflict lacks
  });

  test("zero conflicts -> empty items, no decisions", async () => {
    const actx = setup();
    _advisorServiceDeps.callOp = (async () => ({ ok: true, answers: [], diagnoses: {}, overlap: [], conflicts: [] })) as typeof _advisorServiceDeps.callOp;
    const out = await adviseBatch(actx, { kind: "preflight", summary: "pf", storyIds: ["US-1"] });
    expect(out.items).toEqual([]);
  });
});
```
The `callOp` fakes are cast the way the existing advise tests cast them. If the looseCast ratchet objects, use `makeScriptedCallOp` from `@test/helpers` (added in PR2) instead.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/unit/advisor/batch.test.ts --timeout=60000`
Expected: FAIL (`adviseBatch` not exported).

- [ ] **Step 3: Implement**

`src/advisor/ladder.ts`: add
```ts
/** Usable entries in order; every entry cooling still yields one attempt per entry rather than none. */
export function ladderModels(config: AdvisorConfig, isCooling: (model: ConfiguredModel) => boolean): ConfiguredModel[] {
  const usable = usableAdvisorModels(config, isCooling);
  return usable.length > 0 ? usable : advisorLadder(config);
}
```
In `service.ts` `runLadder`, replace the `usable` / `models` two-liner with `const models = ladderModels(config, isCooling);`. Export these service internals for `batch.ts` (no behaviour change): `configOf`, `describeModel`, `deliverHeadsUp`, and a pure `decisionDraftFor(actx, question, reply, answeredBy, findingSeverity)`, which is today's `buildDraft` taking the question instead of `Asked`. Also export `isCoolingFor(actx)`, the `isCooling` closure `runLadder` builds today, so both ladders use one definition. Add `adviseBatch: (req) => adviseBatch(actx, req)` to the object `createAdvisor` returns, and `adviseBatch(req: BatchRequest): Promise<BatchResult>` to the `Advisor` interface. Use a type-only import from `./batch` and a value import of `adviseBatch` where it doesn't create a cycle. If `batch.ts` imports `service.ts` and vice versa, move the four exported helpers into `src/advisor/service-helpers.ts` and import them from both.

`src/advisor/batch.ts`:
```ts
/**
 * A5 PR3: `adviseBatch` (spec §8). One stateless op call over the model ladder; every valid
 * answer is a standard decision; a missing or invalid answer is that item's fallback (P3-R3).
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "../logger";
import type { AdviseBatchOpOutput, CallContext } from "../operations";
import { adviseBatchOp, validateAdvisorReply } from "../operations";
import { NAX_COMMIT, NAX_VERSION } from "../version";
import { writeAdviceAudit } from "./audit";
import { appendDecision, readTrustedDecisions } from "./ledger";
import { ladderModels } from "./ladder";
import { buildMenu } from "./menus";
import { _advisorServiceDeps, type AdvisorCallContext, configOf, decisionDraftFor, deliverHeadsUp, describeModel, isCoolingFor, type QuestionDraft } from "./service";
import type { AdviceDecision, AdviceQuestion, AdvisorReply } from "./types";

// BatchRequest, BatchItemResult, BatchResult exactly as in Interfaces.

interface BatchRun {
  out: Extract<AdviseBatchOpOutput, { ok: true }> | null;
  error?: string;
  model?: import("../config").ConfiguredModel;
  attempts: Array<{ model: string; error: string }>;
  prompt: string;
}

async function runBatchLadder(actx: AdvisorCallContext, input: Parameters<typeof adviseBatchOp.build>[0]): Promise<BatchRun> {
  const config = configOf(actx);
  const attempts: Array<{ model: string; error: string }> = [];
  const ctx: CallContext = { ...actx.callCtx, sessionOverride: { role: "advisor", discriminator: "advisor-batch" } };
  for (const model of ladderModels(config, isCoolingFor(actx))) {
    try {
      const out = await _advisorServiceDeps.callOp(ctx, adviseBatchOp, { ...input, model, ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}) });
      if (out.ok) return { out, model, attempts, prompt: "" };
      attempts.push({ model: describeModel(model), error: out.error });
    } catch (err) {
      attempts.push({ model: describeModel(model), error: `dispatch: ${errorMessage(err)}` });
    }
  }
  return { out: null, error: attempts.at(-1)?.error ?? "no-output", attempts, prompt: "" };
}
```
Then implement `adviseBatch(actx, req)` to:
1. snapshot the worktree (`_advisorServiceDeps.captureWorktreePatch(actx.workdir)`), read `priorDecisions` (`readTrustedDecisions`) and `prdText` (`_advisorServiceDeps.readPrdText`);
2. for residual, build `questions = req.items.map((d) => ({ ...d, id: _advisorServiceDeps.newId(), askedAtSha: sha }))`;
3. build the op input (`{ kind, summary, items: questions | [], redGates | [], storyIds | [], specPath, prdText, priorDecisions }`) and set `prompt = buildAdvisorBatchPrompt(input)` for the audit;
4. run `runBatchLadder`, measuring the cost with `_advisorServiceDeps.costTotal` before and after;
5. map the result to items:
   - **residual:** for each question, take the answer with its `itemId`. With a `reply`, `decide()` it; otherwise `{ decision: null, fallbackReason: answer.error }`.
   - **pre-flight:** for each `RawPreflightConflict`, keep only `storyIds ∩ req.storyIds` (warn per dropped id, storyId first: `{ storyId: dropped, … }`), and skip the conflict if none remain. Build `question = { id: newId(), askedAtSha, kind: "preflight", feature, storyId: kept[0], summary: description, evidence: [{ source: "spec", ref: specSection, text: description }], options: buildMenu({ kind: "preflight", acRef, specSection }) }` and run `validateAdvisorReply(conflict.raw, question.options)`. If valid, `decide()` it with `appliesTo: kept`; otherwise the item falls back with the validator's error.
6. `decide(question, reply, appliesTo?)` calls `appendDecision(actx.repoRoot, actx.feature, (id) => ({ ...decisionDraftFor(actx, question, reply, run.model, question.findingSeverity)(id), ...(appliesTo ?? carryTargets) }))`, where `carryTargets` is `{ appliesTo: action.toStories }` when the action is a carry. Catch ledger errors into `fallbackReason`.
7. write one audit per item with `writeAdviceAudit`. Use the same record shape as `writeAuditSafe` in service.ts: `question`, `prompt`, `rawReply: JSON.stringify(rawAnswer ?? run.error ?? "")`, `result: { decision }` (or the fallback), `costUsd: cost / Math.max(1, items.length)` and `attempts`. Swallow and warn on write errors;
8. call `deliverHeadsUp` for each decision, then return. Wrap steps 1–8 in one try/catch: any throw returns `{ kind, items: [], diagnoses: {}, overlap: [], fallbackReason: "advisor error: …" }` with the kind's own fields. For residual the items are each question with `decision: null` (so the caller can default them); for pre-flight there are no items.

Keep `batch.ts` under 300 lines; split the pre-flight mapping into `batch-preflight.ts` if it grows. Export `adviseBatch` and the types from `src/advisor/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/unit/advisor --timeout=60000 && bun run typecheck && bun run lint`
Expected: PASS. The existing `advise` tests still pass, which proves the `runLadder` refactor kept its behaviour.

- [ ] **Step 5: Commit**

```bash
git add src/advisor test/unit/advisor
git commit -m "feat(advisor): adviseBatch over the model ladder (per-item decisions, audits, fallbacks)"
```

---

### Task 4: Live workflow advisor (implementer-question + residual) wired into the story loop

**Files:**
- Create: `src/workflow/advisor-live.ts`
- Modify: `src/workflow/types.ts` (`WorkflowRuling` gains `decisionId?`, `toStories?`), `src/workflow/adjudicate.ts` (P3-R10, T9), `src/workflow/stage-env.ts` (use the live advisor), `src/workflow/step-context.ts` (`_workflowDeps.createAdvisor`, `StepContext.outputDir`)
- Test: `test/unit/workflow/advisor-live.test.ts`, extend `test/unit/workflow/adjudicate-close.test.ts` and `test/unit/workflow/stage-env.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`Advisor`, `createAdvisor`, `buildMenu`, `adviseBatch` via `Advisor.adviseBatch`); PR2's `WorkflowAdvisor`, `ResidualRequest`, `ResidualAnswer`, `defaultHold`.
- Produces:
  ```ts
  export interface LiveAdvisorInput {
    readonly advisor: Advisor;
    readonly feature: string;
    readonly storyId: string;
    /** Stories that depend on this one and have not passed yet (carry targets, P3-R1). */
    readonly dependents: readonly string[];
  }
  export function createLiveWorkflowAdvisor(input: LiveAdvisorInput): WorkflowAdvisor;
  export function toWorkflowRuling(findingId: string, d: AdviceDecision): WorkflowRuling | null;
  export function costIfWrongOf(d: AdviceDecision): string;   // P3-R9
  export function dependentsOf(prd: PRD, storyId: string): string[];
  // WorkflowRuling gains:  decisionId?: string; toStories?: readonly string[];
  // StepContext gains:     outputDir: string;
  // _workflowDeps gains:   createAdvisor: typeof createAdvisor;
  ```

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/advisor-live.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { AdviceDecision, Advisor, BatchRequest, BatchResult, QuestionDraft } from "@/advisor";
import { makeTestPRD, makeTestStory } from "@test/helpers";
import { costIfWrongOf, createLiveWorkflowAdvisor, dependentsOf, toWorkflowRuling } from "@/workflow/advisor-live";

function decision(over: Partial<AdviceDecision>): AdviceDecision {
  return {
    id: "D-1",
    questionId: "Q-1",
    kind: "residual",
    chosenOptionId: "A",
    action: { type: "waive", reason: "spec 3.2 allows it" },
    rationale: "the reviewer misread 3.2",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "t",
    model: "powerful",
    memoryMode: "stateless",
    auditRef: "advisor-audit/f/D-1.json",
    ...over,
  };
}

function fakeAdvisor(opts: { advise?: (q: QuestionDraft) => AdviceDecision | null; batch?: (r: BatchRequest) => BatchResult }): Advisor & { asked: QuestionDraft[]; batches: BatchRequest[] } {
  const asked: QuestionDraft[] = [];
  const batches: BatchRequest[] = [];
  return {
    asked,
    batches,
    advise: async (q) => {
      asked.push(q);
      return { decision: opts.advise?.(q) ?? null };
    },
    recordReuse: async () => null,
    adviseBatch: async (r) => {
      batches.push(r);
      return opts.batch ? opts.batch(r) : { kind: "residual", items: [], diagnoses: {} };
    },
  };
}

const finding = (id: string) => ({ id, kind: "quality" as const, severity: "important" as const, issue: `issue ${id}`, file: "src/a.ts", line: 3 });

describe("answerQuestion", () => {
  test("an answer decision returns its text; the question uses the implementer-question menu", async () => {
    const advisor = fakeAdvisor({ advise: () => decision({ kind: "implementer-question", action: { type: "answer", text: "Use Postgres." } }) });
    const live = createLiveWorkflowAdvisor({ advisor, feature: "f", storyId: "US-3", dependents: [] });
    expect(await live.answerQuestion({ storyId: "US-3", status: "NEEDS_CONTEXT", concerns: "Which DB?" })).toBe("Use Postgres.");
    expect(advisor.asked[0]?.kind).toBe("implementer-question");
    expect(advisor.asked[0]?.options.map((o) => o.type)).toEqual(["answer", "hold"]);
    expect(advisor.asked[0]?.evidence[0]?.text).toContain("Which DB?");
  });

  test("hold or no decision -> null", async () => {
    const holds = fakeAdvisor({ advise: () => decision({ action: { type: "hold", reason: "ask a human" } }) });
    expect(await createLiveWorkflowAdvisor({ advisor: holds, feature: "f", storyId: "US-3", dependents: [] }).answerQuestion({ storyId: "US-3", status: "BLOCKED", concerns: "x" })).toBeNull();
    const none = fakeAdvisor({});
    expect(await createLiveWorkflowAdvisor({ advisor: none, feature: "f", storyId: "US-3", dependents: [] }).answerQuestion({ storyId: "US-3", status: "BLOCKED", concerns: "x" })).toBeNull();
  });
});

describe("ruleResidual", () => {
  test("one batch with a residual menu per item; carry only with dependents (Review Focus 3)", async () => {
    const advisor = fakeAdvisor({
      batch: (r) => ({
        kind: "residual",
        items: r.kind === "residual"
          ? r.items.map((q, i) => ({
              question: { ...q, id: `Q-${i}`, askedAtSha: "abc" },
              decision: i === 0 ? decision({ id: "D-7", action: { type: "carry", instruction: "Keep lock order", toStories: ["US-4"] } }) : null,
              ...(i === 0 ? {} : { fallbackReason: "no answer for this item" }),
            }))
          : [],
        diagnoses: { "full-suite": "port clash" },
      }),
    });
    const live = createLiveWorkflowAdvisor({ advisor, feature: "f", storyId: "US-3", dependents: ["US-4"] });
    const answer = await live.ruleResidual({ storyId: "US-3", items: [finding("F1"), finding("F2")], redGates: ["full-suite"] });
    const req = advisor.batches[0];
    if (req?.kind !== "residual") throw new Error("kind");
    expect(req.items.map((q) => q.options.map((o) => o.type))).toEqual([
      ["waive", "defer", "carry", "hold"],
      ["waive", "defer", "carry", "hold"],
    ]);
    expect(req.items[0]?.evidence[0]?.text).toContain("src/a.ts:3");
    expect(answer.rulings).toEqual([
      expect.objectContaining({ findingId: "F1", action: "carry", text: "Keep lock order", toStories: ["US-4"], decisionId: "D-7", source: "advisor" }),
    ]);
    expect(answer.diagnoses).toEqual({ "full-suite": "port clash" });

    const noDeps = fakeAdvisor({});
    await createLiveWorkflowAdvisor({ advisor: noDeps, feature: "f", storyId: "US-3", dependents: [] }).ruleResidual({ storyId: "US-3", items: [finding("F1")], redGates: [] });
    const r2 = noDeps.batches[0];
    if (r2?.kind !== "residual") throw new Error("kind");
    expect(r2.items[0]?.options.map((o) => o.type)).toEqual(["waive", "defer", "hold"]);
  });
});

describe("helpers", () => {
  test("toWorkflowRuling maps waive/defer/carry/hold; other actions -> null", () => {
    expect(toWorkflowRuling("F1", decision({}))).toMatchObject({ findingId: "F1", action: "waive", text: "spec 3.2 allows it", why: "the reviewer misread 3.2" });
    expect(toWorkflowRuling("F1", decision({ action: { type: "defer", reason: "branch review" } }))?.action).toBe("defer");
    expect(toWorkflowRuling("F1", decision({ action: { type: "fix", instruction: "x" } }))).toBeNull();
  });

  test("costIfWrongOf (P3-R9)", () => {
    expect(costIfWrongOf(decision({}))).toBe("high confidence; reversible");
    expect(costIfWrongOf(decision({ confidence: "low", reversible: false, needsHumanConfirm: true }))).toBe("low confidence; hard to undo; needs confirmation");
  });

  test("dependentsOf: stories that list this one as a dependency and have not passed", () => {
    const prd = makeTestPRD([
      makeTestStory({ id: "US-3" }),
      makeTestStory({ id: "US-4", dependencies: ["US-3"], passes: false }),
      makeTestStory({ id: "US-5", dependencies: ["US-3"], passes: true }),
      makeTestStory({ id: "US-6", dependencies: ["US-1"], passes: false }),
    ]);
    expect(dependentsOf(prd, "US-3")).toEqual(["US-4"]);
  });
});
```

Extend `test/unit/workflow/adjudicate-close.test.ts` (P3-R10):
```ts
test("first ruling per finding wins; duplicates and unknown ids are warned about and ignored", async () => {
  // advisor returns rulings [F1 waive, F1 hold, F9 waive] for items [F1]
  // expect returned rulings [F1 waive] and two warn log lines (capture with the logger sink the file already uses, or addSink from @/logger)
});
```
Write it in full against the file's existing fixtures, asserting both the rulings and the two warnings (each with `storyId` first).

Extend `test/unit/workflow/stage-env.test.ts`: `env.advisor` is the live advisor. Override `_workflowDeps.createAdvisor` with a fake `Advisor`, call `env.advisor.answerQuestion(...)`, and assert the fake saw an `implementer-question`. Also assert `sc.outputDir === ctx.runtime.outputDir`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/workflow/advisor-live.test.ts test/unit/workflow/adjudicate-close.test.ts test/unit/workflow/stage-env.test.ts --timeout=60000`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/workflow/types.ts`, in `WorkflowRuling`:
```ts
  /** The advisor decision behind this ruling (absent for deterministic defaults). */
  readonly decisionId?: string;
  /** carry only: the dependent stories whose briefs receive the instruction. */
  readonly toStories?: readonly string[];
```

`src/workflow/advisor-live.ts`:
```ts
/** A5 PR3: the real workflow advisor kinds behind PR2's WorkflowAdvisor seam (spec §8). */
import type { AdviceDecision, Advisor, QuestionDraft } from "@/advisor";
import { buildMenu } from "@/advisor";
import type { PRD } from "@/prd";
import type { ResidualAnswer, ResidualRequest, WorkflowAdvisor } from "./advisor";
import type { GateName, WorkflowFinding, WorkflowRuling } from "./types";

// LiveAdvisorInput exactly as in Interfaces.

export function dependentsOf(prd: PRD, storyId: string): string[] {
  return prd.userStories.filter((s) => (s.dependencies ?? []).includes(storyId) && !s.passes).map((s) => s.id);
}

export function costIfWrongOf(d: AdviceDecision): string {
  return [`${d.confidence} confidence`, d.reversible ? "reversible" : "hard to undo", ...(d.needsHumanConfirm ? ["needs confirmation"] : [])].join("; ");
}

export function toWorkflowRuling(findingId: string, d: AdviceDecision): WorkflowRuling | null {
  const base = { findingId, why: d.rationale, costIfWrong: costIfWrongOf(d), source: "advisor" as const, decisionId: d.id };
  switch (d.action.type) {
    case "waive":
    case "defer":
    case "hold":
      return { ...base, action: d.action.type, text: d.action.reason };
    case "carry":
      return { ...base, action: "carry", text: d.action.instruction, toStories: d.action.toStories };
    default:
      return null;
  }
}

function findingEvidence(f: WorkflowFinding): string {
  const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  const ac = f.acId ? ` [${f.acId}]` : "";
  const fix = f.suggestion ? ` Suggested fix: ${f.suggestion}` : "";
  return `[${f.severity}/${f.kind}]${ac}${where} ${f.issue}${fix}`;
}

export function createLiveWorkflowAdvisor(input: LiveAdvisorInput): WorkflowAdvisor {
  const { advisor, feature, storyId, dependents } = input;
  return {
    async answerQuestion(q) {
      const draft: QuestionDraft = {
        kind: "implementer-question",
        feature,
        storyId: q.storyId,
        summary: `The implementer for ${q.storyId} stopped with ${q.status} and needs an answer to continue.`,
        evidence: [{ source: "agent-diagnosis", text: q.concerns || "(no concern text)" }],
        options: buildMenu({ kind: "implementer-question" }),
      };
      const { decision } = await advisor.advise(draft);
      return decision?.action.type === "answer" ? decision.action.text : null;
    },
    async ruleResidual(req: ResidualRequest): Promise<ResidualAnswer> {
      const items: QuestionDraft[] = req.items.map((f) => ({
        kind: "residual",
        feature,
        storyId,
        summary: f.issue,
        evidence: [{ source: f.kind === "gate" ? "gate" : "finding", ref: f.id, text: findingEvidence(f) }],
        options: buildMenu({ kind: "residual", dependents: [...dependents] }),
        findingSeverity: f.severity,
        ...(f.file ? { anchorFile: f.file } : {}),
        rulingTitle: f.issue,
      }));
      const result = await advisor.adviseBatch({
        kind: "residual",
        storyId,
        summary: `${storyId} reached its fix-round cap with ${req.items.length} open item(s).`,
        items,
        redGates: [...req.redGates],
      });
      if (result.kind !== "residual") return { rulings: [], diagnoses: {} };
      const rulings = result.items.flatMap((item, i) => {
        const finding = req.items[i];
        const ruling = finding && item.decision ? toWorkflowRuling(finding.id, item.decision) : null;
        return ruling ? [ruling] : [];
      });
      return { rulings, diagnoses: result.diagnoses as Partial<Record<GateName, string>> };
    },
  };
}
```
The residual result items keep request order (Task 3 builds them from `req.items` in order), which is why the index lookup holds. Assert that order in a Task 3 test if it isn't covered already.

`src/workflow/adjudicate.ts` (P3-R10): replace the `byId` map with a first-wins map that warns:
```ts
  const known = new Set(req.items.map((i) => i.id));
  const byId = new Map<string, WorkflowRuling>();
  for (const r of answer.rulings) {
    if (!r.findingId || !known.has(r.findingId)) {
      getLogger().warn("workflow", "Advisor ruled on an unknown finding — ignored", { storyId: req.storyId, findingId: r.findingId ?? "(none)" });
      continue;
    }
    if (byId.has(r.findingId)) {
      getLogger().warn("workflow", "Duplicate advisor ruling for a finding — first kept", { storyId: req.storyId, findingId: r.findingId });
      continue;
    }
    byId.set(r.findingId, r);
  }
```

`src/workflow/step-context.ts`: add `readonly outputDir: string;` to `StepContext`, and `createAdvisor` (imported from `@/advisor`) to `_workflowDeps`. Update `test/helpers/workflow-step-context.ts` so `makeStepContext` fills `outputDir`.

`src/workflow/stage-env.ts`: set `outputDir: ctx.runtime.outputDir` on `sc`, and replace `advisor: defaultWorkflowAdvisor` with:
```ts
    advisor: createLiveWorkflowAdvisor({
      advisor: _workflowDeps.createAdvisor({
        callCtx,
        repoRoot: ctx.projectDir,
        outputDir: ctx.runtime.outputDir,
        feature,
        runId,
        specPath: await specPathFor(feature, ctx.projectDir),
        workdir: ctx.workdir,
        ...headsUpChannel(ctx),
      }),
      feature,
      storyId: ctx.story.id,
      dependents: dependentsOf(ctx.prd, ctx.story.id),
    }),
```
- `specPathFor` resolves through `_workflowDeps.resolveFeatureSpec` (the same call `brief.ts` makes) and returns `""` when there is no spec. Put it in `brief.ts` as an exported helper and reuse it there.
- `headsUpChannel(ctx)` returns the same `headsUp` / `queueHeadsUp` pair that `adviseUncategorised` builds (`src/execution/uncategorised-advice.ts`). Read that file and reuse its construction rather than duplicating it. If it is built inline there, extract a small exported helper in that module and call it from both places.

`defaultWorkflowAdvisor` stays exported. Tests use it, and it documents the defaults.

- [ ] **Step 4: Run them to verify they pass**

Run: the three test files, `bun test test/unit/workflow --timeout=60000`, `bun run typecheck`, `bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow src/execution test/unit/workflow test/helpers
git commit -m "feat(workflow): live advisor kinds (implementer-question, residual with carry) wired into the story loop"
```

---

### Task 5: The advisor-answer turn reuses the round's model and time limit (PR2 M1)

**Files:**
- Modify: `src/workflow/implement.ts` (the `answer` turn variant), `src/workflow/story-loop.ts` (`absorbTurn` passes the originating turn)
- Test: extend `test/unit/workflow/implement.test.ts` and `test/unit/workflow/story-loop.test.ts`

**Interfaces:**
- Produces: `ImplementTurn`'s answer variant becomes
  `{ readonly kind: "answer"; readonly text: string; readonly stepUps: number; readonly limit: "implement" | "fix" }`.
  `runImplementerTurn` uses `fixModelFor(story, tierOrder, stepUps)` and `limit === "implement" ? implementMs : fixMs` for it. It never closes the session, because an answer always continues the turn it answers.

- [ ] **Step 1: Write the failing tests**

In `test/unit/workflow/implement.test.ts`:
```ts
test("answer turn after a stepped-up fresh round uses that round's model and fixMs", async () => {
  // fake callOp records input; run { kind: "answer", text: "Use X", stepUps: 1, limit: "fix" } on a story routed "fast"
  // expect input.model === "balanced", input.timeoutMs === fixMs, and no session close
});
test("answer turn after the first implement turn uses the routed model and implementMs", async () => {
  // { kind: "answer", text: "Use X", stepUps: 0, limit: "implement" } -> model undefined, timeoutMs === implementMs
});
```
Write both in full in the file's existing style (`makeStepContext`, the scripted callOp fake, a `sessionManager` fake that records closes).

In `test/unit/workflow/story-loop.test.ts`:
```ts
test("answer turns carry the originating turn's stepUps and limit", async () => {
  // maxFixRounds 5; review fails every time so rounds reach 4 (fresh, stepUps 1);
  // the implementer replies NEEDS_CONTEXT only on the round-4 fix turn; advisor answers "try X" once.
  // expect the answer turn === { kind: "answer", text: "try X", stepUps: 1, limit: "fix" }
  // and an answer to the very first implement turn (separate test case) === { ..., stepUps: 0, limit: "implement" }
});
```
Write it in full with the file's `harness()`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/workflow/implement.test.ts test/unit/workflow/story-loop.test.ts --timeout=60000`
Expected: FAIL (type error: `stepUps` / `limit` missing on the answer turn).

- [ ] **Step 3: Implement**

`src/workflow/implement.ts`:
```ts
  | { readonly kind: "answer"; readonly text: string; readonly stepUps: number; readonly limit: "implement" | "fix" }
// in runImplementerTurn:
  const stepUps = turn.kind === "fix" || turn.kind === "answer" ? turn.stepUps : 0;
  const model = stepUps > 0 ? fixModelFor(sc.story, sc.tierOrder, stepUps) : undefined;
  const timeoutMs =
    turn.kind === "implement" || (turn.kind === "answer" && turn.limit === "implement")
      ? sc.workflow.timeouts.implementMs
      : sc.workflow.timeouts.fixMs;
```
The fresh-round close stays `turn.kind === "fix" && turn.fresh` only.

`src/workflow/story-loop.ts`: `absorbTurn(env, s, outcome, origin)` takes `origin: { stepUps: number; limit: "implement" | "fix" }`. The answer turn becomes `{ kind: "answer", text: answer, stepUps: origin.stepUps, limit: origin.limit }`. The first-implement call site passes `{ stepUps: 0, limit: "implement" }`, and the fix call site passes `{ stepUps: turn.stepUps, limit: "fix" }`.

- [ ] **Step 4: Run them to verify they pass**

Run: the two test files, then `bun test test/unit/workflow --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow test/unit/workflow
git commit -m "fix(workflow): answer turns reuse the answered round's model and time limit"
```

---

### Task 6: Pre-flight runner, `preflight.json`, and rulings in the brief

**Files:**
- Create: `src/workflow/preflight.ts`, `src/workflow/rulings.ts`
- Modify: `src/workflow/brief.ts` (rulings from trusted decisions), `src/workflow/step-context.ts` (`_workflowDeps.readTrustedDecisions`), `src/workflow/index.ts` (export `runPreflight` for PR4)
- Test: `test/unit/workflow/preflight.test.ts`, `test/unit/workflow/rulings.test.ts`, extend `test/unit/workflow/brief.test.ts`

**Interfaces:**
- Consumes: Task 3 (`Advisor.adviseBatch` pre-flight), Task 1 (`describeTarget` from `@/advisor`).
- Produces:
  ```ts
  // preflight.ts
  export interface PreflightConflictRecord {
    readonly questionId: string;
    readonly storyIds: readonly string[];
    readonly summary: string;
    readonly decisionId: string | null;
    readonly action: string;          // decision action type, or "hold" (default)
    readonly fallbackReason?: string;
  }
  export interface PreflightFile {
    readonly schemaVersion: 1;
    readonly overlap: readonly { readonly storyId: string; readonly specSections: readonly string[] }[];
    readonly conflicts: readonly PreflightConflictRecord[];
    readonly fallbackReason?: string;
  }
  export async function runPreflight(input: {
    readonly advisor: Advisor;
    readonly runDir: string;
    readonly storyIds: readonly string[];
    readonly ledger: (storyId: string, text: string) => Promise<void>;
  }): Promise<PreflightFile>;
  export function preflightPath(runDir: string): string;     // <runDir>/preflight.json
  // rulings.ts
  export function rulingsForStory(decisions: readonly AdviceDecision[], storyId: string): string[];
  ```
  Rules:
  - `runPreflight` returns the existing file without calling the advisor when `preflight.json` already exists (resume).
  - Each decided conflict gets a ledger line per story in `appliesTo`: `Ruling: pre-flight <D-n>: <what> — <rationale> — <costIfWrongOf>`. A conflict without a decision gets `Ruling: pre-flight hold (default) — <fallbackReason> — the story runs under the spec as written` on its story.
  - `rulingsForStory` returns:
    - pre-flight supersede: `Pre-flight D-n: <describeTarget(target)> now reads: <newText>`
    - pre-flight hold: `Pre-flight D-n: flagged for a human; run under this default: <reason>`
    - carry: `Carried from <d.storyId> (D-n): <instruction>`

    It selects decisions by `appliesTo` containing the story, in ledger order. Other kinds and actions are not rulings for a brief.

- [ ] **Step 1: Write the failing tests**

`test/unit/workflow/rulings.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { AdviceDecision } from "@/advisor";
import { rulingsForStory } from "@/workflow/rulings";

const d = (over: Partial<AdviceDecision>): AdviceDecision => ({
  id: "D-1", questionId: "Q", kind: "preflight", chosenOptionId: "B",
  action: { type: "hold", reason: "r" }, rationale: "x", confidence: "high", reversible: true,
  needsHumanConfirm: false, decidedAt: "t", model: "m", memoryMode: "stateless", auditRef: "a", ...over,
});

describe("rulingsForStory", () => {
  test("pre-flight supersede/hold and carries that apply to the story, in ledger order", () => {
    const decisions = [
      d({ id: "D-1", appliesTo: ["US-2"], action: { type: "supersede", target: { kind: "ac", storyId: "US-2", acId: "AC-3" }, newText: "14 days" } }),
      d({ id: "D-2", appliesTo: ["US-3"], action: { type: "hold", reason: "keep 30d" } }),
      d({ id: "D-3", appliesTo: ["US-2"], action: { type: "hold", reason: "use UTC" } }),
      d({ id: "D-4", kind: "residual", storyId: "US-1", appliesTo: ["US-2"], action: { type: "carry", instruction: "Keep lock order", toStories: ["US-2"] } }),
      d({ id: "D-5", kind: "residual", storyId: "US-1", action: { type: "waive", reason: "x" } }),
    ];
    expect(rulingsForStory(decisions, "US-2")).toEqual([
      "Pre-flight D-1: US-2 AC-3 now reads: 14 days",
      "Pre-flight D-3: flagged for a human; run under this default: use UTC",
      "Carried from US-1 (D-4): Keep lock order",
    ]);
    expect(rulingsForStory(decisions, "US-9")).toEqual([]);
  });
});
```

`test/unit/workflow/preflight.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Advisor, BatchRequest, BatchResult } from "@/advisor";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { preflightPath, runPreflight } from "@/workflow/preflight";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

function advisorReturning(result: BatchResult): Advisor & { calls: BatchRequest[] } {
  const calls: BatchRequest[] = [];
  return {
    calls,
    advise: async () => ({ decision: null }),
    recordReuse: async () => null,
    adviseBatch: async (r) => {
      calls.push(r);
      return result;
    },
  };
}

describe("runPreflight", () => {
  test("writes preflight.json and a ledger Ruling line per affected story", async () => {
    const runDir = makeTempDir("wf-pf-");
    dirs.push(runDir);
    const advisor = advisorReturning({
      kind: "preflight",
      overlap: [{ storyId: "US-1", specSections: ["3.2"] }],
      items: [
        {
          question: { id: "Q-1", kind: "preflight", feature: "f", storyId: "US-2", askedAtSha: "a", summary: "30d vs 14d", evidence: [], options: [] },
          decision: {
            id: "D-1", questionId: "Q-1", kind: "preflight", chosenOptionId: "B", appliesTo: ["US-2", "US-3"],
            action: { type: "supersede", target: { kind: "ac", storyId: "US-2", acId: "AC-3" }, newText: "14 days" },
            rationale: "spec is newer", confidence: "high", reversible: true, needsHumanConfirm: true,
            decidedAt: "t", model: "m", memoryMode: "stateless", auditRef: "a",
          },
        },
        {
          question: { id: "Q-2", kind: "preflight", feature: "f", storyId: "US-3", askedAtSha: "a", summary: "tz", evidence: [], options: [] },
          decision: null,
          fallbackReason: "optionId B needs an AC reference",
        },
      ],
    });
    const lines: string[] = [];
    const file = await runPreflight({ advisor, runDir, storyIds: ["US-1", "US-2", "US-3"], ledger: async (s, t) => { lines.push(`${s}: ${t}`); } });
    expect(advisor.calls[0]).toMatchObject({ kind: "preflight", storyIds: ["US-1", "US-2", "US-3"] });
    expect(file.conflicts.map((c) => [c.questionId, c.decisionId, c.action])).toEqual([
      ["Q-1", "D-1", "supersede"],
      ["Q-2", null, "hold"],
    ]);
    expect(await Bun.file(preflightPath(runDir)).json()).toEqual(file);
    expect(lines).toEqual([
      "US-2: Ruling: pre-flight D-1: supersede US-2 AC-3 — spec is newer — high confidence; reversible; needs confirmation",
      "US-3: Ruling: pre-flight D-1: supersede US-2 AC-3 — spec is newer — high confidence; reversible; needs confirmation",
      "US-3: Ruling: pre-flight hold (default) — optionId B needs an AC reference — the story runs under the spec as written",
    ]);
  });

  test("existing preflight.json is reused without an advisor call (resume)", async () => {
    const runDir = makeTempDir("wf-pf-");
    dirs.push(runDir);
    await Bun.write(join(runDir, "preflight.json"), JSON.stringify({ schemaVersion: 1, overlap: [], conflicts: [] }));
    const advisor = advisorReturning({ kind: "preflight", overlap: [], items: [] });
    await runPreflight({ advisor, runDir, storyIds: ["US-1"], ledger: async () => {} });
    expect(advisor.calls).toHaveLength(0);
  });

  test("zero conflicts still writes the file (Review Focus 5)", async () => {
    const runDir = makeTempDir("wf-pf-");
    dirs.push(runDir);
    const file = await runPreflight({ advisor: advisorReturning({ kind: "preflight", overlap: [], items: [] }), runDir, storyIds: ["US-1"], ledger: async () => {} });
    expect(file.conflicts).toEqual([]);
    expect(await Bun.file(preflightPath(runDir)).exists()).toBe(true);
  });
});
```
The ledger line's `<what>` is `<action type> <describeTarget(target)>` for supersede, and `<action type>` otherwise. Implement it exactly as the expected strings show.

Extend `test/unit/workflow/brief.test.ts`: stub `_workflowDeps.readTrustedDecisions` to return a carry with `appliesTo: [story id]`, then assert the written brief's "Rulings in force" section contains `Carried from US-1 (D-4): Keep lock order`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/unit/workflow/rulings.test.ts test/unit/workflow/preflight.test.ts test/unit/workflow/brief.test.ts --timeout=60000`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/workflow/rulings.ts`:
```ts
/** Rulings a story's brief must carry (spec §6 step 1, §8): pre-flight rulings and carried instructions. */
import type { AdviceDecision } from "@/advisor";
import { describeTarget } from "@/advisor";

export function rulingsForStory(decisions: readonly AdviceDecision[], storyId: string): string[] {
  const lines: string[] = [];
  for (const d of decisions) {
    if (!d.appliesTo?.includes(storyId)) continue;
    if (d.kind === "preflight" && d.action.type === "supersede") {
      lines.push(`Pre-flight ${d.id}: ${describeTarget(d.action.target)} now reads: ${d.action.newText}`);
    } else if (d.kind === "preflight" && d.action.type === "hold") {
      lines.push(`Pre-flight ${d.id}: flagged for a human; run under this default: ${d.action.reason}`);
    } else if (d.action.type === "carry") {
      lines.push(`Carried from ${d.storyId ?? "an earlier story"} (${d.id}): ${d.action.instruction}`);
    }
  }
  return lines;
}
```

`src/workflow/preflight.ts`:
```ts
/** A5 PR3: the pre-flight batch (spec §8) and preflight.json. PR4 calls runPreflight once before the first story. */
import { join } from "node:path";
import type { AdviceDecision, Advisor } from "@/advisor";
import { describeTarget } from "@/advisor";
import { costIfWrongOf } from "./advisor-live";
import { ledgerText } from "./ledger";

// PreflightConflictRecord, PreflightFile exactly as in Interfaces.

export function preflightPath(runDir: string): string {
  return join(runDir, "preflight.json");
}

function what(d: AdviceDecision): string {
  return d.action.type === "supersede" ? `supersede ${describeTarget(d.action.target)}` : d.action.type;
}

export async function runPreflight(input: {
  readonly advisor: Advisor;
  readonly runDir: string;
  readonly storyIds: readonly string[];
  readonly ledger: (storyId: string, text: string) => Promise<void>;
}): Promise<PreflightFile> {
  const path = preflightPath(input.runDir);
  const existing = Bun.file(path);
  if (await existing.exists()) return (await existing.json()) as PreflightFile;
  const result = await input.advisor.adviseBatch({
    kind: "preflight",
    summary: `Pre-flight for ${input.storyIds.length} stories.`,
    storyIds: [...input.storyIds],
  });
  const items = result.kind === "preflight" ? result.items : [];
  const conflicts: PreflightConflictRecord[] = items.map((item) => ({
    questionId: item.question.id,
    storyIds: item.decision?.appliesTo ?? (item.question.storyId ? [item.question.storyId] : []),
    summary: item.question.summary,
    decisionId: item.decision?.id ?? null,
    action: item.decision?.action.type ?? "hold",
    ...(item.fallbackReason ? { fallbackReason: item.fallbackReason } : {}),
  }));
  for (const [i, item] of items.entries()) {
    const record = conflicts[i];
    if (!record) continue;
    for (const storyId of record.storyIds) {
      const text = item.decision
        ? ledgerText.ruling({ action: "hold", text: `pre-flight ${item.decision.id}: ${what(item.decision)}`, why: item.decision.rationale, costIfWrong: costIfWrongOf(item.decision), source: "advisor" })
        : ledgerText.ruling({ action: "hold", text: "pre-flight hold (default)", why: item.fallbackReason ?? "no advisor ruling", costIfWrong: "the story runs under the spec as written", source: "default" });
      await input.ledger(storyId, text);
    }
  }
  const file: PreflightFile = {
    schemaVersion: 1,
    overlap: result.kind === "preflight" ? result.overlap : [],
    conflicts,
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
  };
  await Bun.write(path, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}
```
`ledgerText.ruling` only formats `text — why — costIfWrong`, so the `action` field passed here doesn't reach the line.

`src/workflow/step-context.ts`: add `readTrustedDecisions` (from `@/advisor`) to `_workflowDeps`.

`src/workflow/brief.ts`: in `writeBrief`, read `const decisions = await _workflowDeps.readTrustedDecisions(sc.projectDir, sc.feature, sc.outputDir).catch(() => [])` and pass `rulings: rulingsForStory(decisions, sc.story.id)` instead of `[]`. On a read failure, log a warning with `storyId` first; the brief still writes.

`src/workflow/index.ts`: export `runPreflight`, `preflightPath` and `type PreflightFile`.

- [ ] **Step 4: Run them to verify they pass**

Run: the three test files, `bun test test/unit/workflow --timeout=60000`, `bun run typecheck`, `bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow test/unit/workflow
git commit -m "feat(workflow): pre-flight runner, preflight.json, and pre-flight/carried rulings in briefs"
```

---

### Task 7: End-to-end advisor test, docs and CHANGELOG

**Files:**
- Create: `test/integration/workflow/advisor-e2e.test.ts`
- Modify: `packages/nax/CHANGELOG.md` (`## Unreleased` → `### Added`)
- Modify: `docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md`: add §16 "PR3 plan rulings" (copy P3-R1..R10 verbatim) and, in §8's kinds table, note that `carry.toStories` is fixed by the menu (P3-R1)

**Interfaces:**
- Consumes: everything above. The test drives `workflowStage.execute` for two stories (US-1, then US-2, which depends on US-1) against a real temp git repo, with the real `createAdvisor`. The fakes are `_workflowDeps.callOp` (implementer/reviews/gates, as in PR2's `story-e2e.test.ts`) and `_advisorServiceDeps.callOp` (advisor ops), both dispatched by op name.

- [ ] **Step 1: Write the test**

`test/integration/workflow/advisor-e2e.test.ts`. Reuse PR2's `story-e2e.test.ts` setup (temp repo, `makeTestRuntime`, `makeScriptedCallOp`, `_workflowStageDeps.buildWorkflowCallContext` stub), with `workflow: { maxFixRounds: 1 }` and two stories where US-2 lists `dependencies: ["US-1"]`.

Scenario A (residual and carry):
- US-1's story review returns one important finding, and the re-review after the one fix leaves it open.
- The fake `adviseBatchOp` answers with the carry option (`optionId` of the carry option in the item's menu, `instruction: "Keep the lock order from US-1"`).
- Assert:
  - US-1 ends `complete-with-rulings`;
  - `decisions.jsonl` has one `residual` decision with action `carry`, `toStories: ["US-2"]`, `appliesTo: ["US-2"]`;
  - the ledger has a `US-1: Ruling: Keep the lock order from US-1 — …` line;
  - after running US-2, US-2's `brief.md` contains `Carried from US-1 (D-1): Keep the lock order from US-1`.

Scenario B (implementer question):
- The first implementer turn replies `NEEDS_CONTEXT` (`concerns: "Which DB?"`), and the fake `adviseOp` answers `optionId: "A"`, `instruction: "Use Postgres."`.
- Assert:
  - the next implementer dispatch's prompt contains `Use Postgres.`;
  - `decisions.jsonl` has an `implementer-question` decision with action `answer`;
  - there is no `answer` turn after a hold reply (a separate case where the advisor picks `B`).

Make the advisor fakes return real `AdviseOpOutput` / `AdviseBatchOpOutput` values (no casts beyond the shared helper's one).

- [ ] **Step 2: Run it**

Run: `bun test test/integration/workflow/advisor-e2e.test.ts --timeout=60000`
Expected: PASS. A failure is a real integration defect: fix it in the owning file, not the test.

- [ ] **Step 3: Docs and CHANGELOG**

`packages/nax/CHANGELOG.md`, under `## Unreleased` → `### Added`:
```
- Workflow mode advisor kinds (A5 PR3): the implementer's NEEDS_CONTEXT / BLOCKED question is answered
  by the advisor into the same session (at most twice per story); at the fix-round cap the open items
  get one batched advisor ruling each (park as reviewer-wrong, defer to the branch review, carry an
  instruction into dependent stories, or flag for a human), with a diagnosis per red gate; and a
  pre-flight batch (run by PR4 at run start) rules on spec/AC conflicts and writes `preflight.json`.
  Every ruling is a standard decision in `decisions.jsonl`; pre-flight rulings and carried
  instructions appear in the briefs of the stories they apply to. New advisor actions `answer` and
  `carry`, and `adviseBatch` for one-call batches over the model ladder.
```
Spec §16: copy this plan's "Rulings on the spec" table verbatim under `## 16. PR3 plan rulings (2026-10-12)`.

- [ ] **Step 4: Full gate**

Run from `packages/nax`: `bun run typecheck && bun run check:all && bun run test:coverage`. Then from the repo root: `bun run check:all`.
Expected: all green. Every new file must meet the 80% per-file coverage floor; top up in the owning task's existing test file if one falls short.

- [ ] **Step 5: Commit**

```bash
git add test/integration/workflow CHANGELOG.md ../../docs/superpowers/specs/2026-10-12-a5-workflow-mode-design.md
git commit -m "test(workflow): advisor kinds end to end; docs: PR3 rulings and changelog"
```
