# PRD Fidelity Report — manifest-retention

**Spec:** `.nax/features/manifest-retention/spec.md`
**PRD:** `.nax/features/manifest-retention/prd.json`
**Repo:** nax @ `e17bc462`, branch `feat/manifest-retention`
**Planner:** `nax plan` 0.78.0, `--profile cross-agent` (agent `codex`, 90.7s)
**Date:** 2026-08-11
**Phases run:** 9 of 9 (1-8 pre-plan, 9 post-plan)
**Verdict:** ✅ ready for `nax run`

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 18/18, 1:1, no compound splitting |
| 2. Behavioural fidelity | ✅ no degradation; no grep/file-content rewrites |
| 3. Orphan PRD ACs | ✅ none |
| 4. File-role delta | ✅ correct; 2 minor planner additions |
| 5. Meta-AC survival | n/a (no meta-ACs) |
| 5b. Correction survival | ✅ `ContextV2ConfigSchema` reached `acceptanceCriteria` |
| 5c. PRD-AC satisfiability | ✅ n/a — Class A, both seam endpoints are new |
| 6. Out-of-scope preservation | ✅ 9/9, none inverted, no unprefixed hoists |
| 7. Terminal-cleanup story | n/a (no code removed) |

**Blockers:** 0 · **Majors:** 0 · **Minors:** 1

## AC mapping

18 spec ACs → 18 PRD ACs, 1:1 and in order. US-001 13, US-002 5 — matching the spec exactly. No compound AC was split, confirming the single-assertion authoring held; the story stays under the project cap of 16 (`.nax/config.json` → `precheck.storySizeGate.maxAcCount`).

Locus tokens survived in full: `purgeStaleManifests`, `handleRunCompletion`, `ContextV2ConfigSchema`, `MAX_MANIFEST_SCAN`, `_manifestPurgeDeps`, `rebuild-manifest.json`, `context-manifest-context.json`, `retentionDays`, and the `warn`/`info`/`debug` log levels.

**Signature reality check:** US-002 AC1 asserts `purgeStaleManifests` is invoked with two arguments (project directory, 30), matching the spec's declared `purgeStaleManifests(projectDir, retentionDays)`. The symbol is new in this spec, so there is no existing signature to contradict.

## Obligation survival

The known planner failure mode is preserving rationale while dropping obligations. Checked explicitly:

| Obligation | Survived |
|:---|:---|
| `check:file-sizes` gate name | ✅ |
| `run-completion.ts` at 549/600 lines | ✅ (both numbers) |
| Non-recursive directory removal | ✅ |
| Preserve-on-uncertainty | ✅ |
| `_manifestPurgeDeps` injection points | ✅ |
| `MAX_MANIFEST_SCAN` cap | ✅ |
| "No code is removed by this feature" | ❌ **dropped — minor, see below** |

## File roles

- **US-001** `expectedFiles`: `src/context/engine/manifest-purge.ts` ✅ correctly placed (not in `contextFiles`), plus `test/unit/context/engine/manifest-purge.test.ts` — a planner addition. Absent on disk, which is correct for `expectedFiles`.
- **US-001** `contextFiles`: all 5 spec `Context Files` preserved, all exist on disk.
- **US-002** `contextFiles`: includes `src/context/engine/manifest-purge.ts`, produced upstream by US-001 — **correct per §4c**, it exists at US-002's runtime because dependencies run first. Planner also added `test/unit/execution/lifecycle-completion.test.ts`, which exists — a helpful minor addition.
- No self-`Creates` file appears in its own story's `contextFiles`.

## Out of scope

All 9 feature-level bullets preserved verbatim. None inverted into an acceptance criterion. No story-scoped deferral was hoisted, so the `US-00N only:` prefix rule does not apply.

Story-level `outOfScope` arrays are planner-authored (the spec declared none) and are **correct boundaries, not orphans**: US-001 defers wiring to US-002, US-002 defers the config key and purge algorithm to US-001. Neither excludes anything its own ACs require, and neither contradicts a feature-level exclusion.

## Minor — "no code is removed" note dropped

**Spec reference:** Design § Integration, the paragraph beginning "No code is removed by this feature."
**PRD reality:** absent from every `description` and `acceptanceCriteria` entry.
**Assessment:** the note was defensive — it existed to stop a downstream reviewer from reading the spec's pervasive "delete"/"remove" language as *code* removal and demanding a terminal-cleanup story or build-gate note. Its loss makes no AC unsatisfiable and removes no obligation. The surviving AC wording is explicit that deletion targets manifest *files at runtime* ("deletes a `context-manifest-context.json` file whose mtime is 31 days old"), so the false-positive risk it guarded against is low.
**Recommended fix:** none required. If a reviewer does raise a cleanup-story objection during `nax run`, quote this report rather than hand-editing `prd.json`.

## Recommendation

Proceed to `nax run -f manifest-retention`. No spec or PRD changes needed.
