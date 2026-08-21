# PRD Fidelity Report — persist-repo-scoped-fixes

**Spec:** `.nax/features/persist-repo-scoped-fixes/spec.md` (@ `51e9f4c12`)
**PRD:** `.nax/features/persist-repo-scoped-fixes/prd.json` — `nax plan --profile cross-agent-mm`, agent `codex`, runId `90c5fb71`, 94.8s
**Reviewed against:** nax repo @ `eeb09eb39`
**Date:** 2026-08-21
**Phase:** 9 of 9 (phases 1-8 passed in the prior pass)
**Verdict:** ✅ ready — 0 blockers, 0 majors, 2 minors

## Summary by check

| # | Check | Result |
|:--|:------|:-------|
| 1 | Spec AC → PRD AC mapping | 19 spec ACs → 20 PRD ACs, all mapped |
| 2 | Behavioural fidelity + signature reality | clean — no degradation, all call shapes match real signatures |
| 3 | Orphan PRD ACs | none |
| 4 | File-role delta (`contextFiles` / `expectedFiles`) | clean |
| 5 | Meta-AC + correction survival | all 4 corrections reached `description`/`acceptanceCriteria` |
| 5c | PRD-AC satisfiability | Class A (new endpoint); 1 minor on fixture preconditions |
| 6 | Out-of-scope preservation | 9/9 preserved, both hoists correctly prefixed |
| 7 | Terminal-cleanup story | N/A — spec is purely additive |
| 8 | `Modifies` → `modifiedFiles` | N/A — spec declares `None`, PRD carries none |

## Check 1 — Spec AC → PRD AC mapping

**US-001 — 6 → 6, one-to-one.**

| Spec AC | PRD AC | Symbol overlap | Drift |
|:--|:--|:--|:--|
| 1 savePRD/loadPRD round-trip | 1 | `savePRD`, `loadPRD`, `repoScopedFixes`, `PersistedRepoScopedFix` | none |
| 2 absent field → `undefined` | 2 | `loadPRD`, `repoScopedFixes` | none |
| 3 `{ resetRef: true }` clears | 3 | `resetFailedStoriesToPending` | none |
| 4 `{ storyIsolation: "worktree" }` clears | 4 | `resetFailedStoriesToPending` | none |
| 5 `{}` leaves unchanged | 5 | `resetFailedStoriesToPending` | none |
| 6 non-failed story untouched | 6 | `resetFailedStoriesToPending` | none |

**US-002 — 13 → 14, one split.**

Spec ACs 1-12 map one-to-one onto PRD ACs 1-12. Spec AC 13 ("rejects with that same
error **and** `ctx.story.repoScopedFixes` is `undefined`") was atomically split by
`nax plan` into PRD AC 13 (rejection identity) and PRD AC 14 (field state). This is the
documented compound-AC split, not drift, and it improves failure attribution — acceptance
generates one test per AC.

## Check 2 — Behavioural fidelity and signature reality

No PRD AC was rewritten into a file-content, grep, or shell assertion. No asserted
arguments were dropped. Every PRD AC remains a runtime test.

Signature reality check on every PRD AC naming a call against an **existing** symbol:

| Asserted call | Real signature | Verdict |
|:--|:--|:--|
| `resetFailedStoriesToPending(prd, { … })` | `(prd: PRD, opts: ResetFailedOptions = {})` — `src/prd/index.ts:319` | arity ✓, opts keys `resetRef` / `storyIsolation` both real |
| `savePRD` / `loadPRD` | `savePRD(prd, path)` `:106`, `loadPRD(path)` `:53` | ✓ |
| `executionStage.execute(ctx)` | `execute: (ctx: PipelineContext) => Promise<StageResult>` — `src/pipeline/types.ts:403`, impl `execution.ts:47` | ✓ |
| `_executionDeps.buildPlanForStrategy` / `.applyPostRunInspection` | both real keys — `execution.ts:184-193` | ✓ |
| `recordRepoScopedFixes(story, records)` | new in US-002; 2-arg shape matches the spec's Interface block | ✓ forward-reference |

**Note on the spec-side correction this check produced.** The PRD says
`executionStage.execute`; the spec said `executionStage.run` in 8 places. `PipelineStage`
declares `execute` and there is no `.run` on a stage — the planner was right and the spec
was wrong. Corrected in `51e9f4c12`; spec and PRD now agree (spec: 10 × `.execute`,
0 × `.run`; PRD: 6 × `.execute`, 0 × `.run`).

## Check 3 — Orphan PRD ACs

None. Every PRD AC traces to a spec AC. No new enum values, status codes, config keys, or
validation behaviour was introduced.

Two `suggestedCriteria` on US-002 (existing entry unchanged on empty/`undefined` input;
recorder spy not called when `plan.run()` rejects) are the planner's **advisory** channel,
not `acceptanceCriteria`. They are promoted only if they survive the hardening pass. Not
scope bleed, and deliberately not pinned — pinning a speculative case converts a safe
suggestion into a permanently-red blocking criterion.

## Check 4 — File-role delta

- **4a `Creates` → `expectedFiles`:** both US-002 `Creates` files are in `expectedFiles`,
  neither in `contextFiles`. Both confirmed absent on disk, as expected for
  `expectedFiles`. US-001 declares no `Creates` and carries no `expectedFiles`. ✓
- **4b `Context Files` → `contextFiles`:** all 9 spec entries (4 on US-001, 5 on US-002)
  are present in the PRD and all 9 confirmed to exist on disk. ✓
- **4c cross-story produced files:** none — US-002 reads no file US-001 authors. N/A.
- **4d helpful additions:** none. The planner added no extra context files.

## Check 5 — Meta-AC and correction survival

The spec carries no meta-ACs. Its one architectural residue — the barrel re-exports —
was correctly routed to a build/static-gate verification note rather than an AC, and
survives as prose in US-002's `description`.

Correction survival from the phases 1-8 pass — **all four in load-bearing fields**, none
confined to `analysis`:

| Correction | PRD destination | Evidence class |
|:--|:--|:--|
| barrel-import rule (`@/prd`, never a leaf path) | US-002 `description` | ✓ prompt-rendered |
| test home `prd-auto-default.test.ts`, not `schema.test.ts` | US-001 `contextFiles` | ✓ structural |
| call-ordering mandate pinned | US-002 `acceptanceCriteria[10]` | ✓ prompt-rendered |
| multi-element `records` input class | US-002 `acceptanceCriteria[3]` | ✓ prompt-rendered |
| observable-synchronicity rewording | US-002 `description` § Failure handling | ✓ prompt-rendered |

`storyPoints` is unset on both stories and `analysis` is present at the top level; neither
is cited as evidence for anything above.

### 5c — PRD-AC satisfiability spot-check

PRD ACs 9-14 are invocation-shaped: they assert `executionStage.execute(ctx)` invokes a
stubbed `_executionDeps.recordRepoScopedFixes`. The Class B trace does **not** apply —
`recordRepoScopedFixes` is created by this story, so this is Class A (one endpoint new,
the path is being built).

**Minor — fixture preconditions are not in the AC text.** `execute()` has three early
returns before `plan.run()` is reached: `!agent` (and `_executionDeps.getAgent` defaults
to returning `undefined`), `validateAgentForTier`, and an unavailable `packageView`. An AC
read literally — "given `executionStage.execute(ctx)` with a plan resolving …" — does not
establish them, and a test that skips them returns `{ action: "fail" }` without ever
calling the spy.

Not graded higher because the spec establishes the path by pointer rather than by AC text:
`test/unit/pipeline/stages/execution-phase-telemetry.test.ts` is in US-002's
`contextFiles`, annotated in the spec as "existing `_executionDeps` stubbing pattern to
mirror", and it stubs exactly these three (`getAgent` at `:75`,
`validateAgentForTier` at `:76`, `packageView` at `:39`). The implementer has the
precedent in hand. Worth one line in the story description if this is revised.

## Check 6 — Out-of-scope preservation

- **6a:** all 9 spec bullets present in `prd.outOfScope`, verbatim, none merged or
  dropped. Well under the 25-item cap. ✓
- **6b:** field present and populated; the spec defers real work, so its presence is
  required and satisfied. No sentinel-phrasing trap (`Nothing is deferred.`) present. ✓
- **6c:** no exclusion surfaced as an acceptance criterion in either story. ✓
- **6d:** both hoisted story-scoped deferrals carry the mandatory prefix —
  `US-002 only: cross-process or cross-worker synchronisation …` and
  `US-002 only: records written after the last savePRD …`. Per the checklist these are
  **not findings**; they are the shape the authoring guide asks for. US-002's
  `story.outOfScope` additionally carries both in unprefixed story-local form, which is
  correct for a story-scoped block. No story's `**Scope** — Out:` bullets contradict a
  feature-level exclusion. ✓
- **6e:** no orphan entries — `prd.outOfScope` has exactly the spec's 9. ✓

## Check 7 — Terminal-cleanup story

N/A. The spec contains no removal, rename, or consolidation work; both stories are purely
additive. No cleanup story is expected and none was invented.

## Check 8 — `Modifies` → `modifiedFiles`

N/A. The spec's `### Modifies` block declares `None` — verified in the prior pass against
the test tree, which carries no `toStrictEqual`, whole-story `toEqual`, or snapshot over
any shape this feature mutates. Both PRD stories carry no `modifiedFiles`, consistent.

## Recommendations

1. **Optional, before `nax run`:** add one line to US-002's description naming the three
   `execute()` guards a seam test must stub (`getAgent`, `validateAgentForTier`,
   `packageView`). Saves the implementer a likely first-iteration failure. The
   `contextFiles` pointer already makes this discoverable, so this is a convenience, not a
   correctness fix.
2. **No PRD edits required.** Nothing in `prd.json` needs hand-patching.

**Gate result: PASS.** The PRD is faithful to the spec and safe to execute.
