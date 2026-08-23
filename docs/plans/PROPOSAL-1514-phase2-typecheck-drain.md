# Proposal: draining `check:test-typecheck` and `check:test-as-unknown-as` (#1514 phase 2)

Successor to `HANDOFF-1514-cast-sweep.md`. Written against `chore/1514-test-debt-drain`
at `f91e94fb2`. Every number below was measured on that tree, not recalled.

**State at hand-off:** casts **102** (from 681), typecheck errors **1946** (from 1969),
`asAny=1398`, `tsSuppress=54`, `ratchetAllow=107`, `absentValue=17`.

## Status — 2026-08-23

**Phases 0–2 are merged.** PR #1683 landed on `main` as `16997cb0f`, closing #1682.

**config-slices and callop-seam are both complete** on `chore/1514-phase3-drain`, verified
independently (not taken from the delegate's report): `src` tsc **0**, `check:all` green
across 25 gates, full suite green, per-file gate **`worse: 0`** measured against the
pre-work baseline.

| | at `main` | now | Δ |
|:--|--:|--:|--:|
| typecheck errors in `test/` | 1757 | **1645** | **−112** |
| `as unknown as` casts | 102 | **102** | 0 |
| `asAny` | 1398 | **1394** | −4 |
| `anyType` | 1890 | **1886** | −4 |
| `looseCast` | 2011 | **2008** | −3 |
| `tsSuppress` / `ratchetAllow` / `absentValue` | 54 / 107 / 17 | 54 / 107 / 17 | 0 |

Against the original #1514 starting point: **casts 815 → 102 (−87%)**, **typecheck
2009 → 1645 (−18%)**.

Note the three counters went **down**, not merely flat. Both phases were specified to add
zero casts and they removed a few instead.

| Phase | Target | State | Doc |
|:--|:--|:--|:--|
| 0 — escape-hatch guard | — | ✅ merged | this doc §4 D0 |
| 1 — `DeterministicOperation<D>` | −95 | ✅ merged | `HANDOFF-1514-phase2-delegable.md` |
| 2 — missing type imports | −94 | ✅ merged | same |
| **config-slices** | −54 | ✅ **done** — 54 sites, 8 commits; residual is 0 | `HANDOFF-1514-config-slices.md` |
| **callop-seam** | −47 | ✅ **done** — tiers 1+2, 2 commits; 8 tier-3 sites left by design | `HANDOFF-1514-callop-seam.md`, `PLAN-1514-callop-seam.md` |
| 4 — dead fixture keys | ~−115 | not started; needs judgement per deletion | — |
| 5 — implicit-any params | ~−103 | not started; `anyType` guards the cheap non-fix | — |
| 6 — remaining seams / `makeObservation` | ~−90 | not started | — |

**Commit tags for the un-started work are descriptive, not numbered** — the original #1514
plan already used "phase 3a" for scaffolding the ratchets and "phase 3c" for the escape-hatch
ratchet, so `#1514 phase 3a` means two different things in this repo's history. Phases 4–6
should pick descriptive tags when they start.

### Verification of the two completed phases

- **config-slices**: the sliced-config error class went **54 → 0**. `makeConfigSlice` plus
  `makeStorySizeGateConfig` (needed because `precheck?: PrecheckConfig` is optional, so the
  generic helper cannot reach through it without asserting).
- **callop-seam**: the generic-`callOp` error class went **55 → 8**, and the 8 survivors are
  exactly the tier-3 files the plan ruled out of scope
  (`story-orchestrator-resume-integration` 7, `story-orchestrator` 1). Seven `src` modules
  gained a monomorphically-typed dep bag; **no cast was added to `src/` or `test/`**, and the
  redundant `callOp: _callOp as typeof _callOp` self-cast in `_diagnosisDeps` was deleted.
  One module the plan had not found — `src/debate/selectors/synthesis.ts` — got the same
  treatment.

### What phase 3 changed about this proposal

Two of its rulings were **wrong**, and measuring on the merged tree caught both:

- **§4 D2 (`makeDeps`) was aimed at the wrong cluster.** Re-clustering showed the partial-bag
  failures are dominated by *config slices* (`ReviewConfig` 34, `PlanConfig` 8,
  `StorySizeGateConfig` 8, `RectificationConfig` 6, `AcceptanceConfig` 4 ≈ 60), while genuine
  dep-bag cases are single-digit. config-slices shipped `makeConfigSlice` instead. `makeDeps`
  may still be worth building later; it was not the lever here.
- **§4 D3 said the `callOp` cluster "needs the contained-seam pattern — one cast inside a
  helper".** It turned out to be the answer for **8 of the 55**, not all. The slot type is
  *inferred* from `_callOp`, and most modules dispatch exactly one op — so annotating the bag
  monomorphically costs **zero casts** and converts an unimplementable variance error into an
  ordinary "fixture is missing fields" error. **Prefer fixing the type over containing a cast
  whenever the code is monomorphic.**

### Open findings — these need a home or they will be lost

- ~~Nothing in the suite exercises the review normalization path.~~ **Retracted — this was
  wrong.** The claim came from `adversarial-retry.test.ts`, whose fixtures stub `callOp` and
  therefore bypass `classifyAdversarialFindings` entirely. That is by design: per its header,
  that file tests ADR-019 retry/fail-open behaviour, not classification.
  `test/unit/review/adversarial-pass-fail.test.ts` (29 tests) drives `runAdversarialReview`
  through the real op path with real LLM JSON, produces real `acDropped` entries, and asserts
  both terminal branches — `passReason === "ac_quote_not_substring_demoted"`
  (`buildHallucinatedAcQuoteResult`) and the mixed-drop fail-closed case
  (`buildUngroundedFailClosedResult`). The path is covered.
  **Lesson: "no test file supplies a non-empty X" is not evidence that X is untested** when a
  sibling file constructs X from real inputs instead of stubbing it. Check the consumers of
  the branch, not the shape of one file's fixtures.
- The 8 tier-3 `callOp` sites are accepted exceptions, not debt to drain: those modules really
  are polymorphic and the generic signature is correct.

### The rule that has held throughout

**No phase may trade one counter against another.** It has fired twice on this work:
`looseCast` rejected the first draft of `makeConfigSlice` at +2 casts, forcing a cast-free
rewrite that types better; and `anyType` exists because 125 `TS7006` errors could otherwise be
cleared with `: any` at zero counter cost.

**Actuals for phases 0–2 (verified by the full §6 gate: `check:all` green, `bun run test`
green, per-file `worse: 0`, baselines updated only after):**

| Phase | Planned Δ | Actual Δ | Notes |
|:--|--:|--:|:--|
| 0 | 0 | **0** | `anyType=1890`, `looseCast=2011` exactly as specified; the four original counters did not move |
| 1 | −95 | **−95** (1946 → 1851) | 39 `TS2741` `resolution` sites replaced via `makeResolvedTestPatterns`; the six `autofix-implementer-strategy` `TS2554` left per handoff (different signature) |
| 2 | −77 | **−94** (1851 → 1757) | extra −17 = masked collateral in the six `plan-decompose-*` files (TS7006 implicit-any on `.map((s) => …)` and TS2322 Mock assignability) that resolved once the type names existed — already counted in the baseline, so the drop is real. One residual: `precheck-run-story-size-gate-routing.test.ts` swapped its two `TS2304 Cannot find name 'NaxConfig'` for two `TS2322` (`_c: NaxConfig` vs `PrecheckConfig`, a sliced view) — file count unchanged (4 = baseline 4), fixture annotation predates the config slicing, out of this phase's import-only scope |

The residue after phase 6 is F7's harder half plus the long tail — those are the ones
where the fixture is deliberately wrong, and they should be documented as exceptions the
way §8 documented the 102 casts, not forced.

---

## 6. Definition of done, per phase

Unchanged from handoff §6, plus one new clause that is the whole point of D0:

- `bun run check:all` green and `bun run test` green **before** any baseline update.
- Per-file typecheck gate at `worse: 0`.
- `check:test-typecheck` baseline lower.
- `check:test-as-unknown-as` baseline **equal or lower**.
- **`asAny`, `tsSuppress`, `ratchetAllow`, `absentValue`, `anyType`, `looseCast` all
  equal or lower.** No phase may trade one counter against another. A typecheck drop
  paired with an `anyType` rise is a failed phase, not a partial success.

---

## 7. What I recommend not doing

- **Do not fix F5 by annotating `: any`.** It is the single cheapest way to book −125 and
  it is pure debt. Phase 0's counter exists to make that impossible to land quietly.
- **Do not enable `noExplicitAny` for `test/**` yet.** 1406 `as any` + 453 `: any` would
  make `bun run lint` unusable. Ratchet first, flip the rule when the counters approach
  zero, retire both counters then.
- **Do not widen a `src/` type to fit a fixture.** Handoff §4 already forbids it and
  nothing enforces it; F4 will tempt hard. D1 is the counter-example of a *legitimate*
  src change: it makes the type describe what the code already does, and it makes the
  compiler stricter, not looser.
