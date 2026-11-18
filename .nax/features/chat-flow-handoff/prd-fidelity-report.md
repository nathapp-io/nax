# PRD fidelity report: chat-flow-handoff (spec-review phase 9)

Date: 2026-11-18. PRD from `nax plan -f chat-flow-handoff --profile native-codex-ds` (about 4 min).

**Verdict:** READY. No blockers or majors.

## Counts

- **Spec ACs:** all 119 survive and map by index.
- **Planner-added ACs:** 9.
  - 5 trace to spec text: US-006 AC19 and AC20, US-008 AC14, AC15 and AC16.
  - 4 are not stated in the spec. These are regression guards and none changes the contract.
- **Stories:** 8 of 8, dependencies equal the spec's, and every `workdir` is `packages/nax`.
- **`branchName`:** `feat/chat-flow-handoff`.
- **`modifiedFiles`:** 7 of 7, reasons byte-identical to the spec.
- **`outOfScope`:** 9 of 9, byte-identical and in order.
- **File roles:** every Creates file is in `expectedFiles` and every Context File is in `contextFiles`. Files made by an upstream story stay in the consumer's `contextFiles`.
- **Contradictions:** no AC contradicts Failure Handling or the koda `FlowHandoffCreateBody` contract.

## Fixes applied by hand

Three of the four planner-invented regression guards moved from `acceptanceCriteria` to `suggestedCriteria`:

- US-005 AC10: a spec-form entry with no `dependsOn` gives `[]`.
- US-007 AC13: a run-only chain with `handoffAvailable` unset is accepted unchanged.
- US-008 AC17: a job-only chain completes with no `stepEnded`.

The fourth guard, US-005 AC11 (empty `features`), was kept. Its error string comes from existing code, and the spec says the spec form keeps its errors.

**AC counts after the fixes:** 17 / 18 / 18 / 14 / 10 / 20 / 12 / 16, all within the gate of 24.

## Kept, harmless

The planner added two context files, both existing and useful: `config/paths/index.ts` (US-003) and `chat/jobs/jobs-provider.ts` (US-007).
