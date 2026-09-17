# PRD Fidelity Report — glob-directory-grouped-output

**Spec:** `docs/specs/SPEC-glob-directory-grouped-output.md`
**PRD:** `.nax/features/glob-directory-grouped-output/prd.json`
**Reviewed against:** `repos/nax` at `86b032892`
**Date:** 2026-09-17
**Phase:** 9 of 9 (PRD fidelity only; phases 1-8 ran before `nax plan`)
**Verdict:** ✅ ready

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | 15 → 15, 1:1, in order, no unmapped spec AC |
| 2. Behavioural fidelity + signature reality | clean — no AC degraded, no arity contradiction |
| 3. Orphan PRD ACs | none |
| 4. File-role delta | clean — 5 `contextFiles`, all on disk; no `expectedFiles` (spec declares no `Creates`) |
| 5. Meta-AC survival / correction survival | clean — the `_globDeps` correction reaches `description` **and** 2 ACs |
| 6. Out-of-scope preservation | 9 spec bullets → 9 `prd.outOfScope` entries, after one repair (below) |
| 7. Terminal-cleanup story | n/a — spec is purely additive, declares no cleanup story |
| 8. `Modifies` → `modifiedFiles` | clean — 1 spec path → 1 entry, `reason` populated, does not open mid-sentence |

## Check 1 — AC mapping

Matched by backtick-token overlap, one-to-one and in document order:

```
S1 →P1  S2 →P2  S3 →P3  S4 →P4  S5 →P5
S6 →P6  S7 →P7  S8 →P8  S9 →P9  S10→P10
S11→P11 S12→P12 S13→P13 S14→P14 S15→P15
orphan PRD ACs: none
```

Three pairs matched on a single shared token (S5, S10, S15) purely because those
ACs carry few backticked identifiers. Each was read in full and confirmed intact:

- **S5/P5** — lossless round-trip. PRD keeps "the reconstructed set equals exactly
  the root-relative paths matched, with no path added and none dropped."
- **S10/P10** — the `MAX_MATCHES` cap. PRD keeps "the total basenames across all
  group lines equals 500."
- **S15/P15** — non-string `pattern`. PRD keeps the exact return value
  `{ content: "pattern must be a string", isError: true }`.

## Check 2 — behavioural fidelity

No AC was rewritten into a file-content or grep assertion. The planner reshaped
every AC into Given/When/Then while preserving symbol, inputs, and expected
output.

**Signature reality:** every invocation AC targets `globTool.run(input, ctx)` —
2 arguments, matching `CodingTool.run(input: Record<string, unknown>, ctx: ToolRunContext)`
in `src/tools/registry.ts`. No hallucinated arity.

**Check 5c (PRD-AC satisfiability, Class B) does not apply.** P11 and P12 are
invocation ACs, but their stubbed symbol `_globDeps.scan` is **new in this spec**,
so there is no existing call path to falsify. Class B requires both endpoints to
already exist.

**Minor, accepted:** P13/P14 render the spec's "documents … by carrying" as
"contains". The subject is `globTool.description`, a runtime value on the
advertised tool schema — not source text — so this is not a file-content
regression. Noted because the wording invites that reading.

## Check 6 — out-of-scope preservation

All 9 spec bullets present, none inverted into an AC, none contradicted by the
story. `story.outOfScope` is `null`, which is expected: `savePRD` strips the
mirrored copies and the root field is the on-disk SSOT.

**One repair was required before this check passed.** The generated PRD carried
**10** entries; the 10th was the literal string
`<!-- spec-writing: completed-through-phase-6 -->`. Cause, proven by calling the
extractor directly rather than inferring it from the PRD:

```
extractSpecOutOfScope(spec)              -> 10 items, last = "<!-- spec-writing: ... -->"
extractSpecOutOfScope(spec minus marker) ->  9 items, last = "Changing the `Read` tool ..."
```

`extractSpecOutOfScope` (`src/prd/out-of-scope-extract.ts:351`) treats a trailing
HTML comment as prose. Per this checklist's §6a the planner is never the cause of
a missing item — here the inverse held, an *extra* item, and the cause was still
extraction. Remediated in the spec (marker removed) and in the PRD (entry
dropped). `nax spec lint` reports 0/0/0 on the unrepaired spec, so the lint gate
does not cover this.

## Check 8 — `Modifies`

```
spec ### Modifies : 1 distinct path
prd modifiedFiles : 1 entry
  path   = "test/unit/tools/read-glob.test.ts"
  reason = "its globTool case \"matches files by pattern, relative to the root\" asserts ..."
```

Counted by path, not bullet. The `reason` opens with a word, not a comma, so no
second path was swallowed.

## Post-edit validation

`prd.json` was hand-patched (one `outOfScope` element removed). Re-validated
through nax's own reader:

```
nax precheck -f glob-directory-grouped-output
  ✓ prd-valid: PRD structure is valid
```

## Note, outside Phase 9 scope

`nax precheck` additionally reports
`✗ agent-cli-available: native CLI not found in PATH`. This is a precheck defect,
not a PRD finding: `checkAgentCLI` (`src/precheck/checks-cli.ts:43`) spawns
`<agent> --version`, and `agent.default` is `native`, which is adapterless and has
no binary by design — `src/precheck/checks-agents.ts:38` already encodes that
exemption for a sibling check. It does **not** block `nax run`: precheck is opt-in
(`src/execution/lifecycle/precheck-runner.ts:41`, skipped unless `NAX_PRECHECK=1`).
