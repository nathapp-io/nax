# Rule Priority Scoring + Section-Budget Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canonical rules' authored `priority` load-bearing downstream of the rules provider, and stop the section budget from abandoning every remaining rule at the first section that does not fit.

**Architecture:** Two independent changes that share one module. `src/context/rules/rule-budget/index.ts` gains `priorityToRawScore()` — a pure, bounded, monotone map from a rule's frontmatter `priority` to a chunk `rawScore` — which `static-rules.ts` uses at chunk construction in place of the constant `1.0`. The same module's `applySectionBudget()` changes its truncation contract from *global* contiguous-tail to *per-rule* contiguous-tail: a rule whose next section does not fit closes out and the walk continues to the next rule, instead of stopping the whole pass.

**Tech Stack:** TypeScript, Bun (`bun:test`).

**Spec:** GitHub issue [nathapp-io/nax#2061](https://github.com/nathapp-io/nax/issues/2061) — proposal items (a) and (b). Read Findings 2 and 3 before starting. `docs/specs/SPEC-bounded-rules-floor.md` §US-002 is the contract being amended by (b).

## What this plan does NOT fix — read before starting

This plan is a **correctness prerequisite, not the relief.** Do not describe it as fixing the budget overrun.

- **(a) is behaviourally inert on its own.** Floor-kind chunks bypass the `minScore` filter (`orchestrator.ts:385-386`) and bypass packing's budget entirely (`packing.ts:169-198`). Nothing today ranks `static` chunks. (a) exists so that the #2061 (c) ruling *can* rank them; until that ruling lands, its only visible effect is the `chunkScores` values in the manifest. Ship it anyway — without it, any ranking-based floor policy ranks rules by `1/tokens`, i.e. by shortness, which is inverted against author intent.
  Inertness was verified, not assumed, on all three paths a score could leak into: the `minScore` drop exempts floor kinds; packing's floor pass admits them before any budget check; and `dedupeChunks` (`dedupe.ts:81-110`) picks the first-seen chunk by iteration order, never by score. No existing test asserts a static chunk's `rawScore`.
- **(b)'s benefit is real but modest.** It removes a cliff; it does not create budget. At the shipped default (`0.4 x 8000 = 3200`) against this repo's ~25k-token corpus, the first rule alone is 2,758 tokens, so continuing the walk recovers only the ~442-token remainder. The gain is larger at mid-list boundaries and at the larger configured budgets, and the behaviour becomes explainable in all cases, but the corpus/budget mismatch is untouched.
- **The mismatch is addressed elsewhere** — by stage-scoped selection (#822, #2060). Do not attempt that here.
- **(c) was ruled on 2026-09-15** ([issue comment](https://github.com/nathapp-io/nax/issues/2061#issuecomment-5678255394)) and is now tasks 9-12 below. The ruling does **not** make (a) live: under concede-and-reserve the floor still packs unconditionally, so nothing ranks static chunks. (a) stays inert for selection and earns its place as manifest telemetry. Do not describe the ruling as activating it.
- **This repo runs with `enforceBudget: false` globally and that stays** (`~/.nax/config.json`). So (b) changes nothing on this machine's own runs. It changes the shipped default path, which is what other repos get. Verification in Task 7 must therefore be done with enforcement explicitly enabled for the measurement only, never by editing the global config.

## Global Constraints

- **`src/context/engine/providers/static-rules.ts` is at exactly 600/600 lines.** `bun run lint` runs `scripts/check-file-sizes.ts` with `SRC_LIMIT = 600`. **Any net line added to that file fails the gate.** Task 2 is designed around this: the helper lives in `rule-budget`, which `static-rules.ts` already imports at line 19, so the change is one widened import specifier plus one substituted value — zero net lines. Do not add a new import line. Do not "tidy" by extracting a local helper.
- `src/context/rules/rule-budget/index.ts` is 136 lines and `test/unit/context/rules/rule-budget.test.ts` is 248/800 — both have room.
- **(b) changes a codified acceptance criterion, not a bug.** `AC5` (`rule-budget.test.ts:111`) asserts the current behaviour verbatim: *"when budget exhausts partway through the first rule, drops every section of every lower-priority rule even if one would fit."* That test MUST be rewritten, and `docs/specs/SPEC-bounded-rules-floor.md` amended with it. This is the one place in this plan where changing a test is correct rather than cheating; every other test that fails is a signal to fix the implementation.
- **Preserve per-rule contiguity.** Rules are prose. A rule delivered with a hole in the middle (sections 0 and 2 but not 1) reads worse than one cleanly cut short. The new contract is *contiguous within a rule, skip forward across rules* — never "fill any gap with anything that fits".
- Error handling per `.nax/rules/error-handling.md`: use `NaxError`; a plain `Error` needs a `// nax-lint-allow: plain-error` marker. Neither change should need to throw.
- **Commands:** `bun run test` (never bare `bun test` — it gives a confident false signal), scoped `CI=1 AGENT=1 bun test --timeout=60000 <files>`, typecheck `bun run typecheck`, lint `bun run check:all`. Run `bun run test:coverage` after adding any `src/` file — it is not part of `check:all`.

## File Structure

| File | Responsibility |
|---|---|
| `src/context/rules/rule-budget/index.ts` | **both changes.** Add `priorityToRawScore()`; change the truncation walk to per-rule contiguous. |
| `src/context/engine/providers/static-rules.ts:19,448` | Widen the existing `rule-budget` import; replace `rawScore: 1.0` with the mapped value. **Zero net lines.** |
| `test/unit/context/rules/rule-budget.test.ts` | New `priorityToRawScore` cases; rewrite AC5; add the cross-rule continuation cases. |
| `test/unit/context/engine/providers/static-rules*.test.ts` | Assert emitted chunks carry distinct, priority-ordered `rawScore`. |
| `docs/specs/SPEC-bounded-rules-floor.md` §US-002 | Amend the contiguous-tail contract (lines ~46, ~107, ~180). |
| `src/context/engine/packing.ts` | **(c)** — non-floor guarantee ahead of the floor pass. 216 lines, room to grow. |
| `src/context/engine/manifest-types.ts` | **(c)** — `totalBudgetTokens` redocumented as a floor-driven minimum; `floorOverageItems` replaced by an overage scalar. 296 lines. |
| `src/context/engine/manifest-builder.ts:106` | **(c)** — record `chunkTokens` for excluded chunks. 130 lines. |
| `src/context/engine/orchestrator.ts:446-463` | **(c)** — downgrade the floor-overage warn to an expected-state metric. **508 lines — watch the 600 gate.** |

---

### Task 1: `priorityToRawScore` — tests first

- [ ] Write failing tests in `test/unit/context/rules/rule-budget.test.ts` for a new exported `priorityToRawScore(priority?: number): number`:
  - strictly decreasing in `priority` (a numerically lower priority returns a strictly higher score);
  - `priority` undefined returns the same value as `FRONTMATTER_PRIORITY_DEFAULT` (100), so a rule that declares nothing is treated as declaring the default;
  - the result is always in `(0, 1]` — bounded, never zero, never negative;
  - non-finite, zero, and negative inputs are clamped rather than producing `Infinity`/`NaN`;
  - two rules from this repo's real corpus order correctly: `priority: 5` outranks `priority: 55`.
- [ ] Run them, confirm they fail for the right reason (symbol missing).
- [ ] Implement in `src/context/rules/rule-budget/index.ts`.

**Recommended mapping — bounded, pivot at the frontmatter default:**

```ts
export function priorityToRawScore(priority?: number): number {
  const p = Number.isFinite(priority) && (priority as number) > 0
    ? (priority as number)
    : FRONTMATTER_PRIORITY_DEFAULT;
  return FRONTMATTER_PRIORITY_DEFAULT / (FRONTMATTER_PRIORITY_DEFAULT + p);
}
```

Yields `priority 5 -> 0.952`, `20 -> 0.833`, `55 -> 0.645`, `100 (default) -> 0.5`.

**Why bounded rather than `DEFAULT / priority`** (which would give `5 -> 20.0` and preserve `1.0` at the default): once the #2061 (c) ruling makes floor chunks compete with non-floor chunks, an unbounded score lets a single high-priority rule dominate every code chunk in the pool. Keeping rules inside `(0, 1]` means the (c) ruling gets to set the rules-vs-code weighting explicitly via `KIND_WEIGHTS`, instead of inheriting it by accident from this mapping. The cost is that all static scores halve relative to today — which is inert, because floor chunks are exempt from both `minScore` and packing. **Record this tradeoff in the module docstring;** whoever takes the (c) ruling needs it.

### Task 2: Wire the mapping into chunk construction — zero net lines

- [ ] Widen the existing import at `static-rules.ts:19` in place:
      `import { applySectionBudget, priorityToRawScore } from "@/context/rules/rule-budget";`
- [ ] Replace `rawScore: 1.0,` at `static-rules.ts:448` with `rawScore: priorityToRawScore(section.priority),`.
- [ ] Confirm `wc -l src/context/engine/providers/static-rules.ts` still reports **600**.
- [ ] Run `bun run lint` and confirm `check:file-sizes` passes.

`RuleSection.priority` is already populated by `buildSection` (`rule-sections/index.ts:81`), inherited from the owning `CanonicalRule`. No plumbing is required.

**Leave `static-rules.ts:581` alone.** That is the budget-notice chunk's `rawScore: 1.0`; it is not a rule and has no priority.

### Task 3: Prove the scores reach the manifest

- [ ] Add a provider-level test asserting that chunks emitted from rules with distinct priorities carry **distinct** `rawScore` values ordered to match priority.
- [ ] Add a regression assertion that the emitted set is no longer uniform — the current production symptom is all 56 `static-rules:*` chunks scoring the identical `0.4212121212121212`. A test that merely checks "score is a number" would have passed throughout the defect.

### Task 4: Per-rule continuation — rewrite AC5 first

- [ ] Rewrite `AC5` (`rule-budget.test.ts:110-130`) to the new contract, keeping its fixture exactly as-is so the diff shows only the expectation change:
  - rule-a (priority 1), 4 sections x 40 tokens; rule-b (priority 2), 2 sections x 10 tokens; budget 100.
  - **New expectation:** `retainedSections` = `["rule-a#a0", "rule-a#a1", "rule-b#b0", "rule-b#b1"]`, `droppedIds` = `["rule-a#a2", "rule-a#a3"]`.
  - Rename the `describe` block — it currently reads "exhausted budget drops lower-priority rules", which will be false.
- [ ] Add cases the old contract could not express:
  - a rule whose *first* section alone exceeds the whole budget does not prevent later, smaller rules from being considered;
  - a rule cut short contributes a **contiguous leading run**, never a run with a hole;
  - `droppedIds` still lists every omitted section, and ordering remains priority-major;
  - `usedTokens` never exceeds `budgetTokens` except via the documented `kept.length === 0` fail-open;
  - `overageTokens` semantics are unchanged (`max(0, totalTokens - budgetTokens)`).
- [ ] Confirm the rewritten AC5 fails against current `main`.

### Task 5: Implement per-rule continuation

- [ ] Replace the single `stopped` flag in `applySectionBudget` (`rule-budget/index.ts:104-127`) with per-rule closure: track the owning rule of the current section; when a section does not fit, mark **that rule** closed (its remaining sections are dropped) and continue the walk to the next rule's sections.
- [ ] Keep the `kept.length === 0` fail-open exactly as-is — the first section overall is still admitted whole.
- [ ] Keep the sort untouched (`priority`, then owner, then `ordinal`). The walk changes; the order does not.
- [ ] Verify the whole existing suite: `CI=1 AGENT=1 bun test --timeout=60000 test/unit/context/rules/ test/unit/context/engine/`.

**Expected fallout:** `test/unit/context/engine/orchestrator-floor-budget-exceeded.test.ts` is the suite most likely to move — check it before assuming a failure there is spurious. `AC4` (leading-run within one rule) and the line-232 test ("truncation drops one boundary rule's tail rather than every rule's tail") should both still pass — they describe within-rule and boundary behaviour, which is preserved. If either fails, the implementation has broken contiguity; fix the implementation, not the test.

### Task 6: Amend the spec and the docstrings

- [ ] `docs/specs/SPEC-bounded-rules-floor.md` §US-002 — amend the contiguous-tail contract at lines ~46, ~107 and ~180. State the new contract (contiguous within a rule, continue across rules) and record that the previous global-stop behaviour was intentional and is being superseded, with a pointer to #2061 Finding 2.
- [ ] `rule-budget/index.ts` module docstring — the "Truncation:" paragraph (lines 20-25) describes the old contract verbatim and must be rewritten.
- [ ] `packing.ts` — no change. The floor exemption is the (c) ruling's subject, not this plan's.

### Task 7: Verify against the real corpus, then measure

- [ ] Write a throwaway harness (scratchpad, not committed) that loads this repo's 13 canonical rules through `splitRuleIntoSections` and runs `applySectionBudget` at the three budgets the 09-14 run actually logged — 4,500 / 6,000 / 9,000 — plus the shipped default 3,200.
- [ ] Record, before and after, for each budget: sections retained, sections dropped, `usedTokens`, and **which rule files survive at all**. The 09-14 baseline is `droppedCount` 50 / 80 / 59 at 4,500 / 6,000 / 9,000.
- [ ] Report the delta as a measurement in the PR body. **Do not claim the budget overrun is fixed** — see "What this plan does NOT fix". The honest claim is: the cliff is gone, priority is now expressible, and here is how much more of the corpus survives.
- [ ] `bun run check:all` and `bun run test` green before pushing.

### Task 8: Review before push

- [ ] Code review **before** opening the PR, not after. Do not trust a subagent's "all green" — re-run the Task 7 harness yourself and confirm the numbers in the PR body match what the code actually produces.
- [ ] PR body: link #2061, state that this implements proposal items (a) and (b) only, and that item (c) — the floor-policy ruling — remains open and is what actually bounds the bundle.

---

## Item (c) — floor policy, ruled 2026-09-15

**Ruling:** concede the floor exemption explicitly and guarantee repo-derived context a slot; defer option 1 (floor items rank). Full rationale in the [issue comment](https://github.com/nathapp-io/nax/issues/2061#issuecomment-5678255394). The load-bearing argument: a dropped code chunk costs one tool call, a dropped rule costs a gate-fix cycle — the agent cannot discover a rule it was never shown.

### Task 9: Non-floor guarantee in `packChunks`

- [ ] Tests first, in the existing packing suite: with a floor that alone exceeds the budget, the top-N non-floor chunks by density are still admitted; N defaults to 3; fewer than N candidates admits all of them; a guaranteed candidate whose own `tokens` exceed `effectiveBudget` is skipped in favour of the next rather than admitted.
- [ ] Implement in `src/context/engine/packing.ts`: select guaranteed non-floor chunks by density **before** the floor pass and admit them first, so their tokens are counted and they cannot be starved. Floor packs unconditionally as today. Remaining non-floor competes for whatever is left via the existing `repairNonFloor`.
- [ ] Export the constant (`NON_FLOOR_GUARANTEE = 3`) rather than inlining it — the ruling's revisit condition depends on being able to tune it.
- [ ] Do not change `FLOOR_KINDS`. The exemption is now intended behaviour.

**Why count and not token share:** Finding 5 means an evicted chunk's token cost is not recorded anywhere, so no percentage or fixed-token reserve could be chosen from evidence. Revisit once Task 11 makes eviction measurable.

### Task 10: Redocument the budget as a minimum, downgrade the warn

- [ ] `manifest-types.ts` — `totalBudgetTokens` doc becomes a floor-driven minimum, not a ceiling. Say plainly that floor kinds bypass it by design and name the ruling.
- [ ] `orchestrator.ts:446-463` — downgrade `logger.warnOnce("Stage budget exceeded by floor items")` to an expected-state metric (debug plus a counter, not a warn). The comment at `:448` already concedes the condition holds on nearly every stage; the log level should agree with it.
- [ ] **`orchestrator.ts` is 508/600.** Keep this edit net-neutral or shrinking; do not add a helper to that file.
- [ ] `packing.ts` module docstring — the "Budget floor rule (spec §AC-6)" paragraph must state the guarantee that now precedes it.

### Task 11: Make eviction measurable (Finding 5)

- [ ] `manifest-builder.ts:106` — record `chunkTokens` for excluded chunks, not only included ones. Today `excludedChunks` names ids whose token cost appears nowhere, so "the budget evicted X tokens of context" is unanswerable from the artefact that exists to answer it.
- [ ] **Do not remove `floorOverageItems`.** It has 53 references across 12 files including `src/metrics/types.ts` and `src/cli/context.ts` — replacing it is a migration, not a fix, and would swamp this change. Instead:
  - fix its semantics in place so it carries only chunks that **individually** crossed the line (`packing.ts:185` currently sets `floorCollectivelyOverflows` once and attributes all 58);
  - **add** a `floorOverageTokens` scalar alongside it, which is the number anyone actually wants;
  - update `manifest-types.ts:154`'s doc comment, which today documents the subset semantic the code does not implement.
- [ ] `orchestrator.ts:447` falls back to `floorItems` when `floorOverageItems` is absent — that path must keep working, and with the corrected semantics it will now fire more often (an empty overage list is the normal case). Check the fallback still produces a sensible `heaviestFloorItems`.
- [ ] Re-run `grep -rn "floorOverageItems" src/ test/` after the semantic change: tests that assert "every floor item is listed" encode the old behaviour and will need rewriting with the same care as AC5.

### Task 12: Confirm `enforceBudget` stays true

- [ ] No code change — the shipped default at `schemas-context.ts:122` stays `true`. This task is a verification and a note in the PR body.
- [ ] Confirm (b) has made enforcement non-destructive before claiming this: re-run the Task 7 harness with the shipped `rulesShare: 0.4`, and report how many rules survive at 3,200 before and after. If the answer is still "one of thirteen", say so — the default should then be reopened rather than quietly kept.
- [ ] Do **not** touch `~/.nax/config.json`. The local `enforceBudget: false` override is a standing choice and stays; it also means none of this repo's own runs exercise the path Task 12 is verifying.
