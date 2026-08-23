# Proposal: draining `check:test-typecheck` and `check:test-as-unknown-as` (#1514 phase 2)

Successor to `HANDOFF-1514-cast-sweep.md`. Written against `chore/1514-test-debt-drain`
at `f91e94fb2`. Every number below was measured on that tree, not recalled.

**State at hand-off:** casts **102** (from 681), typecheck errors **1946** (from 1969),
`asAny=1398`, `tsSuppress=54`, `ratchetAllow=107`, `absentValue=17`.

## Status — 2026-08-23

**Phases 0–2 are merged.** PR #1683 landed on `main` as `16997cb0f`, closing #1682.
Typecheck **2009 → 1757** and casts **815 → 102** measured against `main`; six hatch
counters ratcheted, `src` tsc 0, CI green.

**Phase 3 is in progress** on `chore/1514-phase3-drain` (off `main` @ `16997cb0f`), now at
typecheck **1745**.

| Phase | Target | State | Doc |
|:--|:--|:--|:--|
| 0 — escape-hatch guard | — | ✅ merged | this doc §4 D0 |
| 1 — `DeterministicOperation<D>` | −95 | ✅ merged | `HANDOFF-1514-phase2-delegable.md` |
| 2 — missing type imports | −94 | ✅ merged | same |
| **3a — config slices** | **−54** | seam + worked example landed (`0dd7ba9ac`); 54 sites **ready to delegate** | `HANDOFF-1514-phase3-config-slices.md` |
| **3b — `callOp` dep slot** | **−47** | prototyped both tiers; **ready to delegate** | `HANDOFF-1514-phase3b-callop.md`, `PLAN-1514-phase3b-callop-seam.md` |
| 4 — dead fixture keys | ~−115 | not started; needs judgement per deletion | — |
| 5 — implicit-any params | ~−103 | not started; `anyType` guards the cheap non-fix | — |
| 6 — remaining seams / `makeObservation` | ~−90 | not started | — |

### What phase 3 changed about this proposal

Two of its rulings were **wrong**, and measuring on the merged tree caught both:

- **§4 D2 (`makeDeps`) was aimed at the wrong cluster.** Re-clustering showed the partial-bag
  failures are dominated by *config slices* (`ReviewConfig` 34, `PlanConfig` 8,
  `StorySizeGateConfig` 8, `RectificationConfig` 6, `AcceptanceConfig` 4 ≈ 60), while genuine
  dep-bag cases are single-digit. Phase 3a is `makeConfigSlice` instead. `makeDeps` may still
  be worth building later; it is not the phase-3 lever.
- **§4 D3 said the `callOp` cluster "needs the contained-seam pattern — one cast inside a
  helper".** That is now the answer for **8 of the 55**, not all. The slot type is *inferred*
  from `_callOp`, and five of the seven modules dispatch exactly one op — so annotating the
  bag monomorphically costs **zero casts** and converts an unimplementable variance error
  into an ordinary "fixture is missing fields" error. Prefer fixing the type over containing
  a cast whenever the code is monomorphic. Only `story-orchestrator/run-phase.ts`,
  `finish/ops-impl.ts` and `acceptance/hardening.ts` are genuinely polymorphic.

### Findings the drain surfaced (worth more than the counters)

- **Nothing in the suite exercises the review normalization path.** Every adversarial and
  semantic fixture omits `normalizedFindings` and `acDropped` — the fields
  `src/review/adversarial.ts` reads to decide what is *blocking*. They pass because the code
  tolerates `undefined` there. Exposed by phase 3b tier 1; not yet fixed.
- **`_diagnosisDeps` carries `callOp: _callOp as typeof _callOp`** — a redundant self-cast
  that does nothing. Slated for deletion in phase 3b.
- **`.claude/rules/` had drifted from `.nax/rules/` and nothing checked it**; `test-ratchets.md`
  described two ratchets after a third had shipped. Fixed, and `check:rules-drift` now gates it.

### The rule that has held throughout

**No phase may trade one counter against another.** It has already fired twice on this work:
`looseCast` rejected the first draft of `makeConfigSlice` at +2 casts, forcing a cast-free
rewrite that types better; and phase 2's `anyType` exists precisely because 125 `TS7006`
errors could be cleared with `: any` at zero counter cost.

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
