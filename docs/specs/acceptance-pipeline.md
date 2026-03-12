# Acceptance Test Pipeline — Feature-Level TDD

**Status:** Draft
**Author:** Nax Dev
**Date:** 2026-03-12

---

## Problem

nax verifies that agents' code passes **implementation tests** (unit/integration tests written by the agent itself), but never independently verifies that the built feature matches the **original requirements**. The agent writes both the tests and the code — it can "pass" by testing something slightly different than what was asked.

The acceptance test system exists in code (`src/acceptance/`, `src/pipeline/stages/acceptance.ts`) but is effectively unused because:

1. **Path 1 (direct PRD):** No `spec.md` exists → no `AC-N:` lines to parse → no acceptance tests generated → acceptance stage silently skips
2. **Path 2 (analyze):** Acceptance tests generated from `spec.md` `AC-N:` lines, but only if properly formatted — fragile and rarely triggered

Both paths fail to answer: **"Did the agent build what was asked for?"**

## Solution

Apply TDD at the feature level — the same RED→GREEN pattern used at the story level:

```
PRD loaded
  → Generate acceptance tests from acceptanceCriteria[]     (new)
  → Run them → must FAIL (RED gate)                         (new)
  → Stories execute normally
  → Run acceptance tests again → must PASS (GREEN gate)     (existing, rewired)
```

The acceptance tests are an **independent verification layer** — generated from the original requirements before any agent runs, and validated after all stories complete.

## Design

### Source of Truth

Acceptance tests are generated from `prd.json` `acceptanceCriteria[]` — not from `spec.md`. This works for both:
- **Method 1 (direct PRD):** I write the PRD → criteria exist → tests generated
- **Method 2 (analyze):** `nax analyze` generates PRD from spec → criteria exist → tests generated

### AC Refinement

Raw acceptance criteria are often vague:
```
"Batch role template uses TDD-aligned language"
```

Before generating tests, an LLM refinement step converts vague criteria into concrete, testable assertions:
```
"buildRoleTaskSection('batch') output includes 'RED phase' and does not include 'test-after'"
```

This makes the generated tests deterministic regardless of who wrote the PRD.

### RED Gate (Pre-Execution)

Generated acceptance tests are run immediately. Expected outcomes:
- **Assertion failure** → valid RED ✅ (feature not implemented yet)
- **Compile failure** → valid RED ✅ (imports don't resolve — greenfield project)
- **Already passes** → invalid ❌ (test isn't testing new behavior → filter out)

Tests that already pass are removed from the acceptance suite — they provide no signal.

### GREEN Gate (Post-Execution)

After all stories complete, the filtered acceptance tests run again:
- **All pass** → feature verified ✅
- **Some fail** → feature incomplete — report which AC failed

### File Storage

```
nax/features/<feature-name>/
  prd.json
  acceptance.test.ts        ← generated here
  acceptance-refined.json   ← refined AC (for debugging/audit)
```

Acceptance tests live in the feature directory, **not** in `test/`. They are:
- Excluded from `bun test` (full suite)
- Run only by the acceptance stage via `bun test <specific-path>`
- Temporary — relevant only during feature development

### Integration with Plan/Analyze

For Method 2 (spec.md → analyze → PRD), the refinement can optionally happen during `nax analyze` instead of at `nax run` startup. This saves one LLM call when both analyze and run are used sequentially.

```
nax analyze → PRD + refined AC + acceptance.test.ts
nax run → skips refinement (already done) → RED gate → stories → GREEN gate
```

Detection: if `acceptance.test.ts` already exists in the feature dir when `nax run` starts, skip generation.

## Pipeline Stages

### New Stage: `acceptance-setup` (runs before story execution)

```
Position: after routing, before first story execution
Condition: acceptance.enabled === true
```

Steps:
1. Collect all `acceptanceCriteria[]` from all stories in the PRD
2. Call LLM to refine criteria into testable assertions (with codebase context)
3. Generate `acceptance.test.ts` from refined assertions
4. Run the test file — expect all tests to fail
5. Filter out any tests that already pass
6. If zero tests remain after filtering → warn and continue (no acceptance gate)
7. Save filtered test file + refined criteria JSON

### Modified Stage: `acceptance` (runs after all stories complete)

The existing acceptance stage (`src/pipeline/stages/acceptance.ts`) is mostly correct. Changes:
- Remove dependency on `spec.md` AC-N parsing — tests are pre-generated
- Read test file from feature dir (already does this)
- On failure: report which AC failed (already does this)

## Config

```json
{
  "acceptance": {
    "enabled": true,
    "generateTests": true,
    "testPath": "acceptance.test.ts",
    "refinement": true,
    "redGate": true
  }
}
```

- `refinement`: whether to LLM-refine vague AC before test generation (default: `true`)
- `redGate`: whether to run RED check before stories (default: `true`). Disable for speed if trusting AC quality.

## Acceptance Criteria (for this feature)

1. `acceptance-setup` stage generates `acceptance.test.ts` from PRD `acceptanceCriteria[]`
2. Generated tests fail before story execution (RED gate)
3. Tests that already pass are filtered out with a warning
4. After all stories complete, acceptance tests run and results reported
5. Feature marked incomplete if any acceptance test fails
6. Works with direct PRD (Method 1) — no spec.md required
7. Works with empty src (greenfield) — compile failure counts as valid RED
8. Acceptance tests not included in `bun test` full suite
9. Existing acceptance stage tests continue to pass
10. LLM refinement converts vague criteria to testable assertions

## Stories (Estimated)

| ID | Title | Complexity |
|:---|:------|:-----------|
| ACC-001 | AC refinement module — LLM-based criteria → testable assertions | Medium |
| ACC-002 | Acceptance test generator — generate tests from refined AC (rewrite existing generator) | Medium |
| ACC-003 | `acceptance-setup` pipeline stage — wire refinement + generation + RED gate | Complex |
| ACC-004 | Rewire existing `acceptance` stage to use pre-generated tests | Simple |
| ACC-005 | Config schema + defaults for new fields | Simple |
| ACC-006 | Integration test — full RED→GREEN cycle | Medium |

## Open Questions

1. **Retry on GREEN failure:** Current acceptance-loop.ts generates fix stories and retries. Keep this behavior or just report failure? (Deferred — solve later)
2. **Cost:** Each refinement = 1 LLM call. For a 5-story PRD with 25 total AC, that's one call with ~1K input tokens. Acceptable.
3. **Multi-story AC overlap:** If two stories have similar AC, the generated tests might overlap. Dedup by AC text similarity? (Low priority — rare in practice)
