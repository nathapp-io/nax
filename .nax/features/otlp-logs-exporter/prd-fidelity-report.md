# Spec Review — Phase 9 PRD Fidelity

**Spec:** `docs/specs/SPEC-otlp-logs-exporter.md` (`a0b5f48b`)
**PRD:** `.nax/features/otlp-logs-exporter/prd.json` (generated 2026-07-31 12:07, profile `cross-agent`)
**Reviewed against:** repo at `a0b5f48b`, branch `feat/otlp-logs-exporter`
**Phases run:** 9 (phases 1-8 run at authoring time; this document covers Phase 9)
**Verdict:** ⚠️ revisions needed — 0 blockers, 1 major, 3 minor. Nothing prevents `nax run`.

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 60/60 mapped |
| 2. Behavioural fidelity | ⚠️ 1 major — unstated input-type widening |
| 3. Orphan PRD ACs | ⚠️ 1 minor — grounded addition, accept |
| 4. File-role delta | ✅ clean |
| 5. Meta-AC / correction survival | ✅ both corrections in `acceptanceCriteria` |
| 5c. PRD-AC satisfiability (Class B) | ✅ no Class B ACs |
| 6. Out-of-scope preservation | ⚠️ 1 minor — duplicate entry |
| 7. Terminal-cleanup story | n/a — spec deletes nothing |

Story and AC mapping, 60 spec ACs → 61 PRD ACs:

| Story | Spec ACs | PRD ACs | Dependencies | Verdict |
|:---|---:|---:|:---|:---|
| US-001 Logger sink seam | 13 | 13 | — | 1:1 |
| US-002 Resource attribute builder | 11 | 11 | — | 1:1 |
| US-003 Resource attribute adoption | 8 | 8 | US-002 | 1:1 |
| US-004 LogEntry to LogRecord mapping | 15 | 15 | — | 1:1 |
| US-005 Exporter wiring and lifecycle | 13 | 14 | US-001, US-003, US-004 | +1 addition |

No AC was degraded into a file-content or grep assertion. Every PRD AC retains
`When <condition>, then <observable>` runtime shape.

---

## Major — payload-builder input types must widen, and the spec never says so

**Spec reference:** Design § Data Model, "All five resource-block sites adopt the shared builder"
**PRD reference:** US-003 AC1, AC2, AC5

The spec directs five sites to call the widened `buildResourceAttributes`, but never
states that the payload builders' **input interfaces** must widen to carry the new data.
Actual shapes:

| Input type | Carries today | Needed for the nine attributes |
|:---|:---|:---|
| `TracesInput` (`otlp.ts:73-88`) | `serviceName`, `runId`, `feature` | + `project`, `gitBranch`, `gitSha` |
| `MetricsInput` (`otlp.ts:122-129`) | `serviceName`, `runId` — **no `feature`, no `project`** | + `feature`, `project`, `gitBranch`, `gitSha` |
| span-tree metrics builder (`span-tree.ts:205`) | `(serviceName, runId)` | + `feature`, `project`, `gitBranch`, `gitSha` |
| `HeartbeatMetricsInput` (`heartbeat.ts:94-98`) | `snapshot.attributes` already holds `runId`, `feature`, `project` | derivable — no widening needed |

US-003 AC2 ("the OTLP module `buildMetricsPayload` … resource attributes include
`nax.feature`") is **not satisfiable** against `MetricsInput` as it stands — the function
has no access to a feature name. The implementer must widen the interface.

This is not unsatisfiable in principle (the change is mechanical and `bun run typecheck`
forces it), which is why it is graded major rather than blocker. The risk is scope
perception: an implementer may treat the interface change as unrequested, and adversarial
review may flag it as scope creep, because no AC or design line authorises it.

**Recommended fix:** add one Design line to the spec naming the input-type widening as
in-scope for US-003. Re-running `nax plan` is optional — the compiler forces the change
either way — but re-planning is what carries the sentence into the PRD.

---

## Minor — orphan PRD AC (US-005 AC14), accept

**PRD:** US-005 AC14 — *"When a logs header references unset environment variables, then
export is skipped and the reporter warns with the missing variable names without
consuming a logs-queue retry."*

No 1:1 spec AC. Traceable to the spec's `### Failure Handling` row ("Export skipped with
a warning naming the missing variables; no POST; no batch-queue retry consumed"), which
AC13 covered only partially — I had trimmed the warning and retry halves to stay under
the AC cap. The planner completed the row. It introduces no new enum, status code, config
key, or validation behaviour, so it is not scope bleed.

Two notes: it is compound (three assertions — skipped, warns with names, no retry
consumed) and overlaps AC13. Expect one test asserting three things. Accept.

---

## Minor — duplicate `outOfScope` entry

`prd.outOfScope` holds 11 entries where 10 were expected (9 feature-level + 1
story-scoped). Entries 8 and 9 are the same batch-queue bullet, the second carrying a
line-wrap artifact (`single-retry-then- drop`). All 9 spec exclusions are present, none
was inverted into an AC, and the story-scoped bullet retains its mandatory `US-005 only:`
prefix, so no waiver leaks across stories. Cosmetic noise only.

---

## Minor — planner added existing test files to `contextFiles`

Three stories gained a test file the spec did not list:

- US-001 → `test/unit/logger/logger-redaction.test.ts`
- US-002, US-004 → `test/unit/plugins/builtin/otel-otlp.test.ts`
- US-005 → `test/unit/plugins/builtin/otel-reporter-lifecycle.test.ts`

All three **exist on disk**, so these are helpful additions per check 4d, not findings.
Each story stays within the 5-file `Context Files` bound.

---

## Confirmed clean

**File roles.** US-004 owns `src/plugins/builtin/otel-reporter/logs.ts` in
`expectedFiles` and it appears in no story's own `contextFiles`. US-005 correctly lists it
under `contextFiles` — an upstream dependency (US-004) creates it, so it exists at US-005's
runtime. Per check 4c that is correct, not a finding.

**Correction survival.** Both corrections made during the authoring-time review reached
`acceptanceCriteria`, not just `analysis`:

- US-001 AC8 retains the exact token and expected result — `"token ghp_0123456789abcdefghij failed"` → `"token [REDACTED] failed"`. The value matters: `SECRET_VALUE_PATTERNS` requires 16+ characters after the `ghp_` prefix, so a generic restatement would likely have produced a test that fails for the wrong reason.
- US-003 AC2 retains the disambiguation — *"the OTLP module `buildMetricsPayload`"* — keeping the AC pointed at the payload whose resource block reaches the wire rather than the `PhaseMetricsAggregator` method's, which is discarded at `index.ts:217`.

**Class B satisfiability.** No PRD AC asserts an invocation where both endpoints already
exist. The two invocation-shaped ACs (US-005 AC4/AC5) stub `addSink`, which US-001
creates, so there is no existing call path to falsify.

**Out-of-scope integrity.** No exclusion surfaced as an acceptance criterion. Story-level
`outOfScope` arrays are consistent with their stories: US-003 carries the
heartbeat-datapoint exclusion and its AC4 asserts the bare `feature` key still ships —
consistent, not contradictory.

## Recommendations

1. Add the input-type widening sentence to the spec's Design § Data Model (the one major).
2. Optionally de-duplicate `prd.outOfScope` entries 8/9 — cosmetic.
3. Proceed to `nax run`. No blocker stands in the way.
