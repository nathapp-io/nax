# `nax plan` PRD Fidelity — Spec Assertions Silently Weakened

**Date:** 2026-05-20
**Related:** [`US-005-orchestration-drift.md`](./US-005-orchestration-drift.md)
**Surface:** `nax plan --from <spec>` → `.nax/features/<feature>/prd.json`
**Severity:** High — drift cause is silent; bypasses both spec-review and per-slice gates

## Summary

`nax plan` transforms a spec markdown into a decomposed `prd.json`. During the
US-005 post-mortem, the PRD was shown to be the primary drift surface: load-bearing
mechanical assertions in the spec (executable greps, file-existence checks,
architectural-invariant tests) were paraphrased into behavioural prose, deleted
outright, or augmented with invented scope. The agent then executed against the
weakened PRD and shipped green slices that violated the original spec.

The spec-review skill currently audits `SPEC-*.md` only. It never inspects the
generated PRD. There is no fidelity contract between spec and PRD.

## Concrete Drift Examples (US-005)

Spec at `docs/specs/SPEC-story-orchestrator-consolidation.md` (rev 4) →
PRD at `.nax/features/story-orchestrator-consolidation/prd.json`.

### 1. Executable grep assertions paraphrased into prose

| Spec AC | PRD AC |
|:---|:---|
| AC#6 — `` `grep -rn "runThreeSessionTdd" src/ test/` returns zero matches`` | US-005.S5 Slice C — "runThreeSessionTdd and runFullSuiteGate exports/usages are removed from src and test trees." |
| AC#9 — "no `ThreeSessionTddResult` references remain" | US-005.S5 Slice D — "callers are updated" |
| AC#7 — "file is deleted after migration. All call sites route through `fullSuiteGateOp`." | US-005.S5 Slice C — file-deletion + call-site-rerouting requirements both dropped |

Mechanical commands the spec author hardcoded as executable gates became
prose the agent could satisfy with "looks removed enough." The verification
mechanism that would have caught the drift was destroyed in translation.

### 2. Architectural-invariant ACs deleted

Spec **AC#10**: future-proof grep test asserting only three edit points when adding
a new phase. **PRD: not present.** The invariant guarding against re-introducing
the consolidation-debt has no implementation surface at all.

Spec **AC#8**: wrapper post-run inspection limited by symbol allowlist
(`no callOp`, `no agentManager.*`, `no SessionKeeper`) outside
`buildPlanForStrategy` and op implementations. **PRD US-005.S4 AC#5**: same
intent but widened to "outside plan-run helper paths." The exception clause
expanded from a closed symbol list to a fuzzy "helper paths" predicate.

### 3. Scope invented by candidate-PRD merge

Spec §1A: `FullSuiteGateOutput.status` has 2 values: `"passed" | "rectification-exhausted"`.

PRD US-005.S1 AC#3: status supports **5 values** — adds `disabled`,
`execution-failed`, `inconclusive`.

The PRD's `analysis` field reveals the cause:

> This PRD uses PRD-CD as the baseline … while importing two safeguards from
> PRD-CC: (1) preserve richer full-suite gate failure status taxonomy …

`nax plan` generated multiple PRD candidates internally and **merged them silently**.
The merge imported scope that traces to no spec line. The agent then implemented
behaviour the spec author never wrote.

### 4. AC reshaped during semantic-review

US-005.S2 escalated balanced→powerful after semantic-review caught a deviation
(AC required "deterministic structured failure"; implementation deferred
validation to downstream orchestrator). The agent argued the AC was
contradictory with its own test, escalated, and ended with `status: "passed"`.
The deviation **survived** review because the test the agent wrote asserts
the deferred behaviour — and the system treats green tests as resolution.

## Root Causes

1. **No fidelity contract.** `nax plan` is free to paraphrase any spec text.
   There is no marker for "preserve verbatim."
2. **Candidate-PRD merging is invisible.** When `nax plan` generates multiple
   candidate decompositions and merges them, the merge surfaces only in a
   prose `analysis` field at the bottom of `prd.json`. The user sees the
   final artefact, not the merge points.
3. **spec-review never reads `prd.json`.** Its six phases all target the spec
   markdown. Nothing diffs spec ACs against PRD ACs.
4. **No traceability map.** There is no `spec-ac-to-prd-ac.json` artefact that
   would let any subsequent gate verify each spec AC is covered.

## Proposed Fixes

### A. `[verbatim]` AC syntax in spec-writing

New convention in `docs/guides/spec-writing.md`: ACs prefixed with `[verbatim]`
must appear character-for-character in the PRD. Reserved for executable
commands, grep patterns, file-existence checks, and architectural invariants.

```markdown
- [verbatim] `grep -rn "runThreeSessionTdd" src/ test/ | wc -l` returns `0`
- [verbatim] File `src/tdd/orchestrator.ts` does not exist after this story
```

Enforced by the planner contract (see B) and the spec-review PRD audit (see C).

### B. Planner contract changes (`nax plan`)

1. **Verbatim preservation.** Any backtick-quoted shell command, grep, or
   file-path-existence check in a spec AC tagged `[verbatim]` is copied
   character-for-character into the PRD.
2. **Traceability map.** `nax plan` emits `.nax/features/<feature>/spec-trace.json`:
   ```json
   {
     "specPath": "docs/specs/SPEC-X.md",
     "specRev": "4",
     "mappings": [
       { "specAcIndex": 6, "specAcVerbatim": true,
         "prdAcs": ["US-005.S5#C"], "preserved": true },
       { "specAcIndex": 10, "specAcVerbatim": false,
         "prdAcs": [], "preserved": false, "reason": "dropped" }
     ],
     "orphanPrdAcs": [
       { "prdAc": "US-005.S1#4", "text": "disabled status" }
     ]
   }
   ```
3. **Candidate-merge audit.** If `nax plan` merges multiple PRD candidates,
   the merge must be either (a) user-confirmable in a separate step or
   (b) emit a structured `candidateMerges` field with the diff between
   candidates. The current `analysis`-field-only disclosure is insufficient.
4. **Orphan-AC warning at plan time.** `nax plan` exits non-zero when the
   PRD contains ACs with no traceable spec source, unless `--allow-scope-expansion`
   is passed.

### C. spec-review PRD audit phase

New phase invoked via `/spec-review --prd <prd.json> --spec <spec.md>`:

- **Fidelity diff** — every spec AC maps to ≥1 PRD AC.
- **Verbatim check** — spec `[verbatim]` ACs appear unchanged in PRD.
- **Orphan-AC scan** — PRD ACs with no spec source flagged as scope bleed.
- **Symbol-scope diff** — PRD `contextFiles` vs spec `Context Files`; additions flagged.

Stop-the-line gate: blockers prevent first-story execution.

### D. Per-slice spec-keeper pass

Independent of plan/review, the nax pipeline runs `[verbatim]` ACs (now
preserved through to the PRD) at every story completion. Any failure halts
the run before the next story starts. The terminal story cannot be marked
`passed` while any `[verbatim]` grep returns non-zero.

## Owner / Next Steps

- **`nax plan` changes (B)** — needs its own spec (`SPEC-plan-fidelity-contract.md`)
  and ownership assignment. Touches `src/commands/plan.ts` and the planner LLM
  prompt.
- **Spec-writing (A)** — addressed by edits to `docs/guides/spec-writing.md`
  alongside this finding.
- **spec-review (C)** — addressed by edits to `~/.claude/skills/spec-review/SKILL.md`
  alongside this finding.
- **Per-slice keeper (D)** — separate follow-up; depends on (A) and (B) landing
  first so verbatim ACs actually survive into the PRD.

## Related Findings

- [`US-005-orchestration-drift.md`](./US-005-orchestration-drift.md) — the
  post-mortem that surfaced this; this finding is its load-bearing follow-up.
