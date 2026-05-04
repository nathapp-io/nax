# Autofix Cycle — TDD Ordering, Test-Writer Cover-Up, and Missing Bail Signals

**Date:** 2026-05-04
**Project under test:** [koda](https://github.com/nathapp-io/koda) — feature branch `feat/memory-phase4-graph-code-intelligence`
**Run:** `logs/memory-phase4-graph-code-intelligence/run/2026-05-03T11-36-49.jsonl`
**Affected story:** US-001 (Incremental Graph Diff)
**Status:** Proposed — implementation plan below; partial mitigations from prior session already landed (see [Prior fixes already in place](#prior-fixes-already-in-place))

Five concrete defects were observed in the V2 fix cycle (`runFixCycle` + `runAgentRectificationV2`). They compound: the test-writer locks bugs in, the cycle ignores the agent's "I give up" signal, and budget is wasted on a final validate that has no fix attempt to feed.

---

## Evidence

US-001 trajectory in `2026-05-03T11-36-49.jsonl`:

```
12:56  Initial: 1 finding (lint failure)
12:58  Iter 1: 1 → 5 findings  outcome=regressed-different-source
13:44  Iter 2: 5 → 5 findings  outcome=regressed-different-source
14:53  Iter 3: 5 → 5 findings  outcome=regressed   (implementer + test-writer)
14:53  Cycle exit: max-attempts-per-strategy
```

Three prompt-audit files anchor the analysis:

- `logs/prompt-audit/.../1777815886251-...-reviewer-adversarial-review-t01.txt` — **Adversarial round at 13:44** flags `incremental-graph-diff.service.ts:203`: *"upsertNode deleteMany uses node.id (graphify identifier) instead of GraphNode.id (cuid). This will delete zero rows."*
- `logs/prompt-audit/.../1777818360282-...-implementer-rectification-t01.txt` — **Implementer at 14:26** receives the 5 findings; ends with `UNRESOLVED: The e2e tests expect the old deleteAllBySourceType + {imported, cleared} behavior...`
- `logs/prompt-audit/.../1777819395655-...-test-writer-rectification-t01.txt` — **Test-writer at 14:43** receives the same 5 source-bug findings and reports:
  > Fixed `loads links from GraphLink table` test: now expects **`cuid2`** as target (matches **actual** `getStoredGraph` behavior — it stores cuid in target field)
  >
  > Removed `upsertNode` describe block: the test asserted on `graphNodeUpsert.mock.calls[0][0]` but the actual implementation uses `txManager.run` so `mock.calls[0]` is empty

The test-writer rewrote the assertion to expect the cuid bug the adversarial reviewer had just flagged at line 203, then deleted a failing test entirely. The next adversarial pass at 14:53 reports the same identifier-space bug again, sharper:

> `storedLinkSet` is built from `storedLinks` using `l.target` which is `targetGraphNodeId` (cuid), while `newLink` key uses `link.target` which is the graphify nodeId. **These are different identifier spaces — the comparison will always fail.**

---

## Defect inventory

### D1 — Test-writer covers up source bugs by loosening assertions [BLOCKING]

**Location:** [`src/prompts/builders/rectifier-builder.ts`](../../src/prompts/builders/rectifier-builder.ts) (test-writer prompt) and [`src/pipeline/stages/autofix-cycle.ts:104-114`](../../src/pipeline/stages/autofix-cycle.ts#L104-L114) (test-writer strategy).

The test-writer prompt forbids removing tests but permits rewriting assertions to "match actual behavior." When adversarial review's whole point is *"actual behavior is wrong,"* the test-writer's natural response is to lock the wrong behavior in.

**Concrete instance:** Test-writer at 14:43 changed the test expectation from the *spec-correct* graphify nodeId to the *bug-introducing* cuid, citing *"matches actual `getStoredGraph` behavior"* as justification. This is the exact bug the reviewer flagged.

### D2 — Strategy ordering is implementer-then-test-writer; should be inverted (TDD) [BLOCKING]

**Location:** [`src/pipeline/stages/autofix-cycle.ts:83-117`](../../src/pipeline/stages/autofix-cycle.ts#L83-L117).

`buildAutofixStrategies` returns `[implementer, testWriter]`. With both `coRun: "co-run-sequential"`, `selectExecutionGroup` runs implementer first then test-writer in the same iteration. This is the wrong order:

- **Current**: implementer fixes source → test-writer writes tests → tests get bent to match (possibly still-broken) source.
- **TDD-correct**: test-writer writes a *failing* test that captures expected behavior → implementer makes the test pass → bug cannot be locked in by an over-permissive test.

### D3 — `collectTestTargetedChecks` leaks source findings into test-writer prompt [HIGH]

**Location:** [`src/pipeline/stages/autofix-cycle.ts:77-79`](../../src/pipeline/stages/autofix-cycle.ts#L77-L79).

```ts
function collectTestTargetedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return collectFailedChecks(ctx).filter((c) => c.findings?.some((f) => f.fixTarget === "test"));
}
```

Filters at the **check** granularity but the test-writer's `buildInput` uses the entire check (with all findings, source-targeted ones included). Result: when the adversarial check has any test-targeted finding, the test-writer also receives the source-bug findings — exactly what happened in iter 3 (test-writer prompt at 14:43 lists 5 errors, all about source files like `incremental-graph-diff.service.ts:240`).

### D4 — Implementer's `UNRESOLVED:` signal is ignored [HIGH]

**Location:** [`src/findings/cycle.ts:243-261`](../../src/findings/cycle.ts#L243-L261) (no bail signal extraction) and [`src/pipeline/stages/autofix-cycle.ts:94-102`](../../src/pipeline/stages/autofix-cycle.ts#L94-L102) (implementer strategy surfaces `unresolvedReason` only via `extractApplied.summary`).

When the implementer's response ends with `UNRESOLVED: <reason>`, the agent has explicitly given up. The cycle nonetheless runs the full validate (semantic + adversarial LLM calls — observed at ~6 minutes wall-clock for iter 3) and only notices on the *next* loop iteration that the cap is hit.

The signal exists in `output.unresolvedReason` and is captured into `fa.summary`, but no bail predicate consumes it.

### D5 — Off-by-one: validate runs after the final allowed fix attempt [MEDIUM]

**Location:** [`src/findings/cycle.ts:156-200`](../../src/findings/cycle.ts#L156-L200).

Loop order:
1. Cap check (passes — `attempts < max`)
2. Execute fix (counter += 1)
3. Validate (full LLM review)
4. Push iteration; loop top
5. Cap check fails → exit

The validate at step 3 on the last allowed attempt produces findings the cycle has no budget to act on. They are recorded in `finalFindings` but never given a fix attempt. With `maxAttempts=N`, the cycle does N fix attempts and produces N+1 validation reports — the last one is diagnostic-only.

### D6 — Escalation reason discards the actual blocking findings [LOW]

**Location:** [`src/pipeline/stages/autofix.ts:243-248`](../../src/pipeline/stages/autofix.ts#L243-L248).

Cap-exhausted escalation surfaces `"Autofix exhausted: review still failing after fix attempts"`. The next escalation tier receives no information about *which* findings remain. `result.finalFindings` is available but discarded.

---

## Prior fixes already in place

From the prior compacted session (do not redo):

| Fix | Location | What it does |
|:---|:---|:---|
| Reverse `findUnresolvedReason` iteration order | `autofix-cycle.ts:127-135` | Most recent UNRESOLVED wins over stale iter-1 messages |
| Suppress `unresolvedReason` on cap exit | `autofix-cycle.ts:230-231` | Cap-bound exits no longer attribute escalation to a stale UNRESOLVED |
| Gate `if (!agentFixed && unresolvedReason)` | `autofix.ts:182` | Don't escalate "reviewer contradiction" when validate confirmed all findings resolved |
| Merge blocking findings into single warn log | `adversarial.ts:382-392` | Removes the split debug+warn pair that hid finding details |

These remove the *misleading* escalation messages, but do not address D1–D6: the test-writer still covers up bugs, the cycle still wastes a validate after UNRESOLVED, and the escalation message is still uninformative.

---

## Implementation plan

Five PRs, roughly ordered by value-to-risk. PRs 1–3 close the cover-up loop; 4–5 cut wasted budget; 6 improves escalation hand-off.

### PR 1 — Tighten test-writer prompt against assertion-loosening (D1)

**Touches:** `src/prompts/builders/rectifier-builder.ts` (test-writer rectification builder).

Add explicit constraints to the test-writer prompt:

> - Do NOT loosen assertions to match current implementation behavior. If a test is failing, the source code is the suspect — not the test.
> - Do NOT delete a failing test because the implementation makes it hard to assert on. Refactor the test if needed; never silently drop coverage.
> - You are encoding the **specification**, not the **current behavior**. If the two disagree, write the test against the spec and let the implementer fix the source.

Add a regression test asserting the new strings are in the prompt output.

**Risk:** Low. Pure prompt change.

### PR 2 — Fix `collectTestTargetedChecks` finding leak (D3)

**Touches:** `src/pipeline/stages/autofix-cycle.ts`.

Two changes:

1. Filter `c.findings` down to test-targeted findings before passing to the test-writer's `buildInput`.
2. If the filtered findings list is empty for a check, drop the check entirely from the test-writer's input.

Add unit test: a check with mixed source/test findings yields a test-writer input containing only the test-targeted ones.

**Risk:** Low. Localized; test-writer prompt is already only meant for test-file work.

### PR 3 — Invert strategy order to TDD-style: test-writer before implementer (D2)

**Touches:** `src/pipeline/stages/autofix-cycle.ts` (`buildAutofixStrategies`); possibly `src/findings/cycle.ts` if order-of-execution semantics need reinforcing.

Two parts:

**3a. Reorder.** Return `[testWriter, implementer]` from `buildAutofixStrategies`. With `co-run-sequential`, `selectExecutionGroup` runs them in the order returned, so the test-writer runs first within an iteration.

**3b. Broaden test-writer applicability.** Today `appliesTo: (f) => f.fixTarget === "test"` — only fires on test-file findings. To convert *source-bug* adversarial findings into TDD cycles, the test-writer needs a second mode: when it sees a `severity: "error"` finding with `fixTarget: "source"` from an adversarial source, it writes a *failing* test capturing the spec-correct behavior described by the finding. The implementer then sees both the original finding and the failing test.

This requires a new prompt mode in the test-writer builder ("write a failing test that captures this expected behavior; do not modify source") and a small extension to the strategy's `appliesTo` and `buildInput`.

**3c. Pass test-writer output to implementer in same iteration.** Today `implementer.buildInput` reads `failedChecks` from `ctx`, which is the *previous* validate snapshot. After 3a runs the test-writer first, the implementer needs to know about the new failing tests. Two options:

- **Lightweight:** include the names of the test files the test-writer touched (from the iteration's `fixesApplied[].targetFiles`) in the implementer's input.
- **Heavier:** re-run lint/typecheck (cheap mechanical) between strategies in an iteration so the implementer's `failedChecks` reflects the new failing tests; skip the expensive LLM checks.

Start with lightweight; revisit if implementer regression rate doesn't drop.

**Risk:** Medium. The TDD inversion is a real behavior change; needs an integration test that simulates an adversarial finding round-trip and verifies the cycle no longer locks in the bug.

### PR 4 — Bail on `UNRESOLVED:` before running validate (D4)

**Touches:** `src/findings/cycle.ts`, `src/pipeline/stages/autofix-cycle.ts`.

Add a typed bail signal. Two-step:

**4a.** Extend `FixApplied` (or a sibling extracted field) to carry an explicit `unresolved?: string` set by `extractApplied`. Today the implementer surfaces this in `summary`, but `summary` is a free-form field also used for non-bail cases — collisions risk false bails.

**4b.** In `runFixCycle`, after `fixesApplied` is populated and *before* `cycle.validate(ctx)` runs, check: if any `fa.unresolved` is set, exit with `exitReason: "agent-gave-up"` (new variant) and `bailDetail: <reason>`. Skip validate.

Update `runAgentRectificationV2`:
- Map the new exit reason to `succeeded: false` and propagate `unresolvedReason`.
- The `if (!agentFixed && unresolvedReason)` gate in `autofix.ts` already routes this correctly to the "reviewer contradiction" escalation.

**Risk:** Low-medium. Skipping validate means the cycle never gets a chance to detect "implementer was wrong, validate confirms all clean." This is acceptable: the agent's UNRESOLVED is treated as authoritative; the next escalation tier picks up.

### PR 5 — Skip the wasted validate on the final allowed attempt (D5)

**Touches:** `src/findings/cycle.ts`.

After executing the fix in step 2 of the loop, before calling `cycle.validate`, check: if every active strategy has now reached its `maxAttempts`, the next loop pass would exit on cap regardless. In that case:

- Option A: skip validate entirely; exit immediately with `cycle.findings` (the pre-fix snapshot).
- Option B: run a "cheap-only" validate (mechanical checks, no LLM) — caller-supplied via a new optional `cycle.cheapValidate` hook. If it returns empty findings, exit `resolved`; otherwise exit `max-attempts-per-strategy`.

Start with A. Cost saving is the wall-clock of the entire LLM review (~6 min observed in this run). Loses the ability to detect "last fix actually resolved everything" — acceptable; if the agent emitted UNRESOLVED, PR 4 already short-circuits this path.

**Risk:** Medium. Changes cycle exit semantics on the last attempt. Update tests asserting `exitReason` for cap-bound cycles.

### PR 6 — Surface `finalFindings` in the cap-exhausted escalation reason (D6)

**Touches:** `src/pipeline/stages/autofix-cycle.ts` (compute digest), `src/pipeline/stages/autofix.ts` (use it).

When `result.exitReason === "max-attempts-per-strategy"` and `result.finalFindings.length > 0`, build a one-line digest:

```
Autofix exhausted: 5 adversarial findings remain
  - error-path × 2 in apps/api/src/rag/incremental-graph-diff.service.ts
  - assumption × 1 in apps/api/src/rag/incremental-graph-diff.service.ts
  - convention × 1, abandonment × 1 in apps/api/src/rag/rag.controller.ts
```

Pass this string as the escalation `reason` instead of the generic `"Autofix exhausted: review still failing after fix attempts"`.

**Risk:** Low. Pure message change; no behavior change.

---

## Sequencing

Recommended PR order: **1 → 2 → 4 → 6 → 3 → 5**.

- 1 + 2 stop the test-writer from making things worse (cheap, low-risk).
- 4 + 6 stop wasted work and improve escalation messages (low-risk).
- 3 is the structural TDD inversion — higher value but needs careful integration testing.
- 5 is an efficiency win that depends on the cycle exit semantics not surprising other consumers.

Each PR includes its own regression test against a synthetic finding fixture.

---

## Out of scope (recorded for a follow-up)

- **D7 — Reset per-strategy attempt cap on `regressed-different-source`.** When iter 1 introduces a totally new family of bugs, the original attempt budget is "stolen" from the new family. A smarter cap could track attempts per finding-source. Risky (cycle-forever potential); deferred until the TDD inversion in PR 3 has been observed in practice — it may render this moot by reducing regression rate.
- **D8 — `priorityForCheck` maps `adversarial` to `"architectural"` (Priority 5, lowest).** When test failures coexist with adversarial findings, the rectifier prompt buries adversarial bugs below test failures. Tracked separately; not on this critical path.
