> **Update 2026-08-19:** Every finding below except ENH-6 has been fixed (see
> "Resolution" note per finding). ENH-6 was investigated and found to be
> parity with `flows/nax-finish/nax-finish.flow.ts`, which drops `channel`
> from the persisted result too — not a port-fidelity defect, so left as-is
> pending a real plan-5 decision on whether to add the field at all.
> `tsc`/`lint`/ratchets/tests all still pass after the fixes.

# Deep Code Review: finish PR/escalation layer (`feat/finish-pr-escalate`)

**Date:** 2026-08-19
**Reviewer:** Claude (AI)
**Branch:** `feat/finish-pr-escalate` vs `main`
**Plan:** `docs/superpowers/plans/2026-08-19-finish-pr-escalate.md`
**Files:** 23 changed (~2000 LOC `src/`, ~1500 LOC `test/`)
**Gates:** `bun x tsc --noEmit` PASS · `bun run lint` PASS (all ratchets unchanged: `test-as-unknown-as` 830/830, `test-typecheck` 2014/2014) · `bun test test/unit/finish test/unit/forge test/unit/plugins` — 1026 pass / 0 fail

---

## Overall Grade: A- (86/100)

The port is faithful to the plan's architecture to an unusually high degree: the template merger is provably byte-identical to the `flows/` original (confirmed by diff and by the required drift-guard test), `machine.ts`'s diff is exactly the one mandated `state.gatesRan = gates.ran` assignment, `flows/` is completely untouched, and the four throw/no-throw contracts (D4.3–D4.6) are implemented with the right asymmetry in the right places. The residual risk is narrow and concentrated at the fail-open/fatal boundary in the PR-composition path — one real HIGH bug and a couple of MEDIUM gaps, all one try/catch or one test away from closed.

---

## Findings

### 🟠 HIGH

#### BUG-1: `openDraftFinishPr` can throw despite its "never throws" contract
**Severity:** HIGH | **Category:** Bug
**File:** `src/finish/pr/open.ts:134-139`

`hasOpenPr` is wrapped in try/catch, but the subsequent `openPr(...)` call is not. `openPr` only converts a *non-zero exit* into `success: false` — a rejecting `deps.run` (e.g. `gh` not installed, or the wall-clock-timeout path throwing) propagates straight out of `openDraftFinishPr` → `ops.openDraftPr` → the machine's outer catch, escalating an otherwise healthy run at step 3.

**Risk:** Violates D4.5, which explicitly lists "a forge CLI that could not answer" as a return-null case. On any machine without a working `gh`/`glab` binary, every finish run would escalate at the draft-open step instead of just skipping the draft.

**Fix:** Wrap the `openPr(...)` call (or the whole function body) in the same try/catch that already guards `hasOpenPr`, returning `null` on any throw.

**Resolution:** Fixed — `openDraftFinishPr` now wraps its whole body in one try/catch. `ops-impl.ts`'s `openDraftPr` was also hardened the same way for the ctx-load/render step above it, and a regression test (`openDraftPr returns null rather than throwing when the forge cannot be spawned, per D4.5`) was added.

---

### 🟡 MEDIUM

#### BUG-2: `promotePr` treats a body-render failure as fatal, not just a push failure
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/finish/ops-impl.ts:136-148`

D4.6 deliberately makes `commitAndPush` and `openOrPromotePr` fatal. But `loadFinishPrContext` / `buildFinishBody` sit between them, uncaught — a render-time throw (e.g. a `Finding` shape `escapeTableCell` can't handle) escalates a run whose branch is already pushed and whose gates are all green. This is the exact "already-promoted green run rewritten to escalated" failure D4.4 exists to prevent for `narrate`, one call earlier in the same terminal path.

**Fix:** Either wrap the context-load/render step in try/catch with a minimal title/body fallback, or confirm (and document) that the loader's fail-open guarantees make this unreachable in practice — currently that guarantee is asserted, not tested at this call site.

**Resolution:** Fixed — added `buildPrContentOrFallback` in `ops-impl.ts`, which wraps the load+render step and falls back to a generic `fix(<feature>): nax-finish automated fixes` title and an explanatory body on any throw. `promotePr` now always calls `openOrPromotePr`, never aborting on a render failure once the push has already succeeded.

#### BUG-3: `escalate` drops the D4.7 sync note on the no-forge path
**Severity:** MEDIUM | **Category:** Bug
**File:** `src/finish/ops-impl.ts:152-159`

`syncNote` is computed from a failed `commitAndPush`, then the function immediately returns `{ deliveryError: "no forge detected" }`, discarding it. The one case where a human most needs "the partial fixes were never pushed either" is exactly the case where that information is silently lost.

**Fix:** Fold `syncNote` into the `deliveryError` string (or a structured field) before returning on the no-forge branch.

**Resolution:** Fixed — `escalate` now tracks `pushError` separately and folds it into the no-forge `deliveryError` string (`"no forge detected; partial fixes could not be pushed either: ..."`). A regression test asserts the sync note reaches the posted comment on the forge-present path.

#### ENH-4: D4.7's sync-note behaviour is untested
**Severity:** MEDIUM | **Category:** Enhancement (test coverage)
**File:** `test/unit/finish/ops-impl.test.ts:147-159`

The only escalate-push test asserts the wip commit message, not that a `commitAndPush` failure appends `> Note: nax-finish could not push its partial fixes` to the comment — the actual locked decision. Also untested: D4.6's "push failure is fatal" for `promotePr`, `escalate` returning `{ url }` on success, and `openDraftPr` returning `null` when `forgeKind` is null.

**Fix:** Add the missing assertions; these are exactly the paths BUG-1/BUG-3 would have been caught by.

**Resolution:** Fixed — added `promotePr rejects when the push fails, per D4.6`, `escalate appends a sync note to the comment when the partial-fix push fails, per D4.7`, and `escalate returns the delivered url on a successful comment` to `ops-impl.test.ts`.

#### ENH-5: D4.12's own stated test criterion — "the field survives to the rendered body" — isn't actually checked end-to-end
**Severity:** MEDIUM | **Category:** Enhancement (test coverage)
**File:** `test/unit/finish/machine-end-to-end.test.ts:262`

Coverage of `gatesRan` is split across three disjoint unit tests (machine sets it, loader reads it, renderer emits it), but the end-to-end green-path test only asserts `## Verification` is present, not a `- Gates:` line. The plan's own rationale for D4.12 is that a dropped wire renders as *no line at all* and would go unnoticed — which is precisely the scenario this gap leaves unguarded.

**Fix:** Add `expect(lastEditBody).toContain("- Gates: ...")` to the green-path e2e test.

**Resolution:** Fixed — `machine-end-to-end.test.ts`'s green-path test now asserts `lastEditBody` contains `"- Gates: test"` (the fixture's configured gate command).

---

### 🟢 LOW

#### ENH-6: `EscalationOutcome.channel` is computed then discarded
**File:** `src/finish/ops-impl.ts:165`
`postEscalation` returns which channel was used (`"telegram" | "pr-comment"`), but the adapter drops it and `FinishResult` has no field for it. Per `escalate.ts`'s own comment, the plugin needs to read this from the result file to know whether it should still send a Telegram message. Likely intended for plan 5, but worth flagging now since the value is thrown away here.

**Resolution:** Not changed. `flows/nax-finish/nax-finish.flow.ts:462-475` computes the identical `channel` value at its escalate node and *also* never persists it onto `FinishResult` (`flows/nax-finish/types.ts:226-252` has no `channel` field either) — the native port is exact parity with the flow, not a regression introduced by this plan. Adding a `channel` field to `FinishResult` would be new scope beyond what any of D4.1-D4.12 calls for, and the plan explicitly reserves config/plugin wiring for plan 5. Left as a flagged gap for that plan rather than fixed here.

#### STYLE-7: `src/forge/deps.ts` comments are stale after the lift
**File:** `src/forge/deps.ts:23-24, 47`
Points at a nonexistent path (`src/plugins/builtin/nax-finish/index.ts:66-97`), references a test seam (`_autoPrDeps`) this module doesn't have, and the hardcoded timeout message (`"[auto-pr] command killed..."`) will misattribute a wedged `git push` during a finish run to auto-PR in the escalation comment. D4.11 mandated a verbatim lift of the *code*, not comments only true at the old call site.

**Resolution:** Fixed — the header comment now points at the real `defaultRun` source (`src/plugins/builtin/auto-pr/index.ts`) and describes the actual test-seam split (auto-pr keeps `_autoPrDeps`, this module's callers inject `ForgeDeps` directly). The timeout stderr tag was changed from `[auto-pr]` to `[forge]` so a wedged subprocess during a finish run doesn't misattribute itself to auto-PR; confirmed no test asserts the old string.

#### STYLE-8: `updatePrBody` bypasses the module's own injectable warn seam
**File:** `src/finish/pr/open.ts:103, 108`
Calls `process.emitWarning` directly instead of routing through `_finishPrDeps.warn` like its sibling `context.ts` does for the identical concern. Consequence: the failure-path tests can only assert "did not throw," not that a warning fired, and the test run prints unsuppressable stack traces.

**Resolution:** Fixed — added a module-local `_openDeps.warn` seam in `open.ts` (mirroring `_finishPrDeps.warn`'s shape, since `ForgeDeps` itself has no `warn` method and adding one would ripple beyond this module) and routed both `updatePrBody` failure branches through it. The `process.emitWarning` calls in the test output are unchanged in the two `updatePrBody` tests, since those still exercise the real default — this is a testability seam, not a behavior change.

#### STYLE-9: Inconsistent error stringification within one function
**File:** `src/finish/ops-impl.ts:156` (`String(err)`) vs `:167` (`errorMessage(err)`)
`String(naxError)` yields `"NaxError: <msg>"`, differing from every other error surface in the module. Faithful to the original flow's behavior, so low priority, but worth normalizing since `errorMessage` is imported two lines away.

**Resolution:** Fixed as part of the BUG-3 change — `escalate` now uses `errorMessage(err)` for the push failure too, consistently with the rest of the module.

#### BUG-10: `fix` spreads `callCtx` without clearing `sessionOverride`
**File:** `src/finish/ops-impl.ts:117`
`{ ...callCtx }` inherits any `sessionOverride` already present on the caller's context. Inert today (nothing wires a context with one yet), but once plan 5 does, a fix call could silently inherit a reviewer role. Pass `callCtx` unchanged or explicitly clear the field to make intent unambiguous.

**Resolution:** Fixed — `fix()` now spreads `{ ...callCtx, sessionOverride: undefined }`, explicitly clearing any inherited role.

#### STYLE-11: New test files fail `biome check` (pre-existing pattern, not a regression)
`test/unit/finish/{escalate,machine-end-to-end,machine-loops,ops-impl,pr-context}.test.ts`, `test/unit/forge/template-merge.test.ts` have import-order/formatting violations. `bun run lint` doesn't run biome over `test/`, and existing files (`test/unit/finish/route.test.ts`) fail identically, so this doesn't block the ratchets — noted only so it isn't mistaken for a clean biome pass.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | BUG-1 | S | `openDraftFinishPr`: wrap `openPr` call so it never throws (D4.5) |
| P1 | BUG-3 | S | `escalate`: fold sync note into the no-forge return |
| P1 | ENH-4 | S | Add tests for D4.6/D4.7 fatal-push and sync-note paths |
| P1 | ENH-5 | S | Assert `- Gates:` line survives in the e2e green path |
| P2 | BUG-2 | M | Decide/implement fail-open behavior for body-render failure in `promotePr` |
| P2 | BUG-10 | S | Clear `sessionOverride` when building the fix call context |
| P3 | ENH-6, STYLE-7/8/9 | S | Wire `channel` through, fix stale comments, use `_finishPrDeps.warn`, normalize error stringification |

---

## Locked-Decision Compliance (D4.1–D4.12)

All confirmed compliant except the narrow gaps above (D4.5 partially violated by BUG-1; D4.6/D4.7 correctly implemented but under-tested):

- **D4.1** — `flows/` untouched (`git diff main...HEAD -- flows/` empty); `src/forge/template-merge.ts` byte-identical to the original apart from the mandated header swap; drift-guard equivalence test present.
- **D4.2** — context/body/open/index split matches exactly.
- **D4.3** — `postEscalation` throws `NaxError`s with correct codes; adapter catches and returns `{ deliveryError }`.
- **D4.4** — `narrate`'s full body is wrapped, not just the LLM call.
- **D4.5** — mostly correct; see BUG-1.
- **D4.6** — push-then-promote, both fatal, correctly implemented; see BUG-2 for the render-step gap between them.
- **D4.7** — best-effort push implemented; see BUG-3 for the dropped note on one branch.
- **D4.8** — `prBody` is a factory option using the existing `FinishPrBodySettings` type; no new type declared.
- **D4.9** — `_finishOpsDeps = { callOp }` seam present and exported from `@/finish`.
- **D4.10** — `sessionOverride.role` set to `"finish-review-spec"` / `"finish-review-quality"`, no new resolver field.
- **D4.11** — `defaultForgeDeps` is a straight lift including the timeout mapping; auto-PR's own copy untouched.
- **D4.12** — `machine.ts` diff is exactly the one assignment; see ENH-5 for the missing e2e assertion.

Import discipline, file-size caps, `as unknown as` ratchet, and the no-emoji rule all hold with no violations found.
