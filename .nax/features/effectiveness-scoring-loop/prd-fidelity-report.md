# PRD Fidelity Report — effectiveness-scoring-loop

**Spec:** `docs/specs/SPEC-effectiveness-scoring-loop.md`
**PRD:** `.nax/features/effectiveness-scoring-loop/prd.json` (regenerated after spec fixes)
**Reviewed against:** nax repo at `bba5c1b7`
**Date:** 2026-08-13
**Phase:** 9 (PRD fidelity), run formally against `checklists/phase-9-prd-fidelity.md`
**Verdict:** ✅ ready — 1 minor, no blockers, no majors

Supersedes the pass against the pre-fix PRD, which carried one major.

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | 37/37 mapped, zero splits |
| 2. Behavioural fidelity + signature reality | Pass, 1 minor (`buildManifest` call shape) |
| 3. Orphan PRD ACs | None |
| 4. File-role delta | Pass, 5 helpful additions (minor, §4d) |
| 5. Meta-AC / gate-note survival | Pass — US-002 size gate survived |
| 5b. Correction survival | Pass — both corrections in `description`, not `analysis` |
| 5c. PRD-AC satisfiability | Pass — all invocation ACs are Class A |
| 6. Out-of-scope preservation | 9/9 feature + 4/4 prefixed story deferrals |
| 7. Terminal-cleanup story | N/A — no removal keywords |
| 8. `Modifies` → `modifiedFiles` | Pass — 0 spec paths, 0 entries |

## Resolved since the previous pass

**Major (closed) — `featureId` absence unpinned.** The spec gained a Failure
Handling row and US-003 gained AC-15: *"When `loadFeatureManifests` is called
without a feature ID, then it returns an empty manifest list without throwing."*
It landed in `acceptanceCriteria`, the strongest survival channel. US-003 is now
15 ACs; 37 total. This closes the gap where
`loadFeatureManifests(projectDir, undefined)` was unspecified and an unattached
run could have thrown out of the context stage.

## Check 1 — AC mapping (pass)

37 spec ACs → 37 PRD ACs, 1:1, no atomic splits. Per story: US-001 6, US-002 6,
US-003 15, US-004 10. All within the project cap of 24.

Locus tokens verified in PRD prose: `GitHistoryProvider.fetch`,
`CodeNeighborProvider.fetch`, `scopePaths`, `touchedFiles`, `buildManifest`,
`chunkScopePaths`, `chunkProviders`, `providerId`, `loadFeatureManifests`,
`deriveProviderWeights`, `chunkEffectiveness`, `FLOOR_KINDS`, `scoreChunk`,
`scoreChunks`, `rawScore`, `includedChunks`, `excludedChunks`,
`below-min-score`, `contextStage.execute`, `config.context.v2.enabled`,
`ContextRequest`, `providerWeights`, `scoreEffectiveness`, `sizeCorrelation`.

No AC degraded into a file-content or grep assertion; none lost its asserted
arguments.

## Check 2 — Minor: `buildManifest` call shape (unresolved, planner-owned)

Five PRD ACs (US-001 5, US-002 5, US-003 1–3) read "… is passed to
`buildManifest`". The real signature is
`buildManifest(inputs: ManifestInputs)`, with chunks at `inputs.packed`.

The spec was amended to say "as `inputs.packed` to `buildManifest`". **The
planner discarded the qualifier on regeneration** — `inputs.packed` occurs zero
times in `prd.json`, as do `buildManifest(inputs` and `ManifestInputs`. This is
planner rewrite behaviour (every AC is recast into `When … then …` form), not a
spec defect, and a further re-plan would reproduce it.

Not escalated, and deliberately not hand-patched:

- The prose is **compatible** with the real signature, not contradictory — it
  fails the blocker condition in check 2, which requires an asserted call shape
  that contradicts the real one.
- `manifest-builder.ts` appears in four stories' `contextFiles`, so the
  implementer opens the real signature and the existing
  `makeInputs({ packed })` pattern in `manifest-builder.test.ts` before writing.
- The checklist sanctions in-place PRD edits only for `modifiedFiles`, "a
  structural field the planner does not author". `acceptanceCriteria` is
  planner-authored; editing it by hand would desync the PRD from its spec and be
  reverted by any later re-plan.

Residual exposure: the correct call shape reaches the implementer through the
source file rather than the prompt.

## Check 4 — File roles (pass)

No self-`Creates` file appears in its own story's `contextFiles`.
US-002's `code-neighbor-chunk.ts` and US-003's `provider-weights.ts` are
correctly in `expectedFiles` only.

Per §4c, US-004's `contextFiles` correctly **retains**
`src/context/engine/provider-weights.ts`, authored by its upstream dependency
US-003 — it exists at US-004's runtime. Explicitly not a finding.

Planner-added existing files (§4d, minor, useful): `manifest-builder.ts` and
`effectiveness-eval.ts` on US-001 and US-002; `effectiveness.ts` on US-003. All
are genuine reads the ACs require. Every spec `Context Files` entry survived.

## Check 5 / 5b / 5c

**5 — gate-note survival.** US-002's build/static-gate note survived into the
story `description`: it names the 613-line current size, the 600-line limit and
`check:file-sizes`. The size constraint is therefore visible at run time rather
than encoded as an unimplementable AC.

**5b — correction survival.** Both spec-review corrections reached
`description`, never `analysis` alone:
- US-003 — "`deriveProviderWeights` takes manifests as a parameter and does
  **not** call `loadFeatureManifests`; the context stage does."
- US-004 — the same separation restated from the consumer side.

**5c — satisfiability.** Three invocation-shaped ACs (US-004 7, 8, 10). All are
**Class A**: the stubbed symbols `deriveProviderWeights` and
`loadFeatureManifests` are created by US-003, so the wiring is authored by this
feature and there is no pre-existing call path to falsify. The enabling flag
`config.context.v2.enabled` is set by each AC's own fixture, satisfying the
Class B guard condition had it applied.

Independently confirmed the named entry point can supply the asserted data:
`contextStage` derives the feature id at `src/pipeline/stages/context.ts:78`
and `:151` and carries `ctx.projectDir` at `:69`, `:126`, `:152`. With AC-15 now
pinning the absent-id case, both branches are specified.

## Check 6 — Out of scope (pass)

All 9 feature-level exclusions present in `prd.outOfScope`, wording preserved.
No exclusion surfaced as an acceptance criterion (§6c). No story's
`**Scope** — Out:` bullets contradict a feature-level exclusion (§6d).

All 4 story-scoped deferrals carry their `US-00N only:` prefixes, which §6d
rules explicitly **not a finding**.

## Check 8 — Modifies (pass)

The spec's `### Modifies` block declares zero paths by design — no existing test
carries a closed-world assertion these changes break (verified in Phase 2:
`git-history.test.ts` and `code-neighbor.test.ts` assert `pullTools` and
captured matchers; `scoring.test.ts:109` asserts ordering;
`manifest-builder.test.ts` uses hand-built fixtures). `modifiedFiles` is `null`
on all four stories. Consistent; nothing invented.

## Recommendation

Ready for `nax run`. The single remaining minor is planner-owned, mitigated by
`contextFiles`, and not worth a third plan cycle.

Two things to watch during the run, both flagged in the spec:

1. **US-002** must land the `code-neighbor-chunk.ts` extraction before adding
   code — `code-neighbor.ts` is at 613 lines, grandfathered, and cannot grow.
   `bun run lint` is the gate.
2. **US-003's constants** (`k`, `MIN_WEIGHT`, `MIN_OBSERVATIONS`) are
   deliberately unpinned; the property ACs are the only contract.
