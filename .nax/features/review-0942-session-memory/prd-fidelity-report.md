# PRD fidelity — review-0942-session-memory

**Reviewed against:** `spec.md` and `prd.json` in this directory, nax at `4ea1b84dd`, 2026-11-28.  
**Phases run:** 1 of 9 (--phase 9: phases 1–8 skipped by request).  
**Verdict:** Revisions needed. The planned behaviors survive; one verification instruction does not reach the implementer.

## Summary

Phase 9: 17 spec criteria mapped to all 19 PRD criteria in 2 stories; 2 dependency sets and workdirs, 10 specified file-role entries (8 context, 1 create, 1 modify), 1 additional context entry, 5 exclusions and 0 new named symbol references checked. No orphan criteria, invented dependencies, inter-story seams or terminal-cleanup story. **0 blockers, 1 major, 1 minor.** No implementation tests run: this checks plan fidelity, not code correctness.

## Acceptance mapping

Numbers are one-based within each story. All retain runtime assertions.

| Story | Spec → PRD | Assertion preserved |
|---|---|---|
| US-001 | 1 → 1 | Actual references with two events pending, before drain |
| US-001 | 2 → 2 | Storage span across reclamation cycles |
| US-001 | 3 → 3 | Full ordered delivery |
| US-001 | 4 → 4–5 | Same-call delta merge; different calls stay distinct |
| US-001 | 5 → 6–7 | Delivered controls leave cap; stall fires once |
| US-001 | 6 → 8 | Linear movement bound over 8,192-event drain |
| US-002 | 1 → 1 | Zero sidecar operations per marker |
| US-002 | 2 → 2 | Only `turn` changes, measured against latest save |
| US-002 | 3 → 3 | Absent sidecar: zero I/O, reference preserved and recoverable |
| US-002 | 4 → 4 | Missing document defaults and private POSIX mode |
| US-002 | 5 → 5 | Legacy array wrapped without sidecar migration |
| US-002 | 6 → 6 | Unversioned/v1 fields preserved |
| US-002 | 7 → 7 | Invalid JSON/null/scalar rejected without overwrite |
| US-002 | 8 → 8 | Future numeric schema rejected without overwrite |
| US-002 | 9 → 9 | Malformed image list rejected without overwrite |
| US-002 | 10 → 10 | Failure before atomic rename preserves prior bytes |
| US-002 | 11 → 11 | Invalid v2 message container rejected without sidecar operations |

## Findings

**Major — bounded verification command does not reach a story.** Spec § Verification (line 79) supplies six test paths, a wall-clock deadline and Bun’s per-test deadline. Both story descriptions refer to “shared analysis” rather than including the command. The top-level `analysis` has the command but is not delivered in a story prompt. Put the exact spec command and `packages/nax-agent` working directory in the verification instructions for the combined changes, to run once both suites exist. Keep the package gates; no new AC or story dependency is needed. Recheck the implementer-visible instructions before starting the run.

**Minor — extra read-only context.** In addition to the three context paths in spec lines 24–27, US-001 includes `packages/nax-agent/src/internal.ts`. It exists and is relevant to keeping diagnostics off the public API; keep it. No requested file was omitted or misclassified.
