# PRD Fidelity Report: step-graph-g3

- Spec: `docs/specs/SPEC-step-graph-g3-story-port.md` (`6cf818a20`)
- PRD: `.nax/features/step-graph-g3/prd.json` (`e69ea5535`, after the hand edit made in response to the first Phase 9 pass)
- Date: 2026-10-20
- Verdict: READY. No blockers, no majors, 2 minors.

## Counts

| Check | Result |
|---|---|
| 1. Spec AC to PRD AC | 20/20 mapped. The splits are tagged `AC-NNa..f`: AC-1 to 1-3, AC-2 to 4, AC-3 to 5, AC-4 to 6-7, AC-5 to 8-9, AC-6 to 10-13, AC-7 to 14-15, AC-8 to 16-17, AC-9 to 18, AC-10 to 19, AC-11 to 20-21, AC-12 to 22-25, AC-13 to 26-31, AC-14 to 32, AC-15 to 33-34, AC-16 to 35-36, AC-17 to 37-38, AC-18 to 39-40, AC-19 to 41-42, AC-20 to 43-47. |
| 2. Behavioural fidelity | 47/47 derived ACs keep the spec's symbol, inputs and expected value. The produces sets, transition lists, cost-stop calls, resume values, error context, outcome literals and turn kinds all match. None is a grep or file-content AC. No call shape contradicts a real signature. |
| 3. Orphan ACs | 4 (48-51), drawn from Failure Handling rows 1-2 and § Equivalence evidence. None adds scope (see Minors). |
| 3b. Dependencies | Spec says "No dependencies.", PRD has `[]`. Match. |
| 4. File roles | Context Files 5/5 are in `contextFiles`. Creates 4/4 are in `expectedFiles`. No created file also appears in `contextFiles`. |
| 5/5b. Meta-ACs and corrections | No meta-ACs. All corrections from spec-review passes 1 and 2 reach `description`: `TurnOrigin` and `LoopState` move, only `turnLabel` is re-exported, the working copy and its node locals, `costLimited`, the `feature-machine-graph.test.ts` precedent. |
| 5c. Satisfiability | 2 invocation ACs where both ends already exist. AC 44: `adjudicateResidual` calls `advisor.ruleResidual(req)` once when items are present (`adjudicate.ts:14-16`), and F1 is a `spec` finding, so it stays in `items`. AC 48: `steps.gates` is reached from `evaluate`, can be overridden through `over.steps` (`workflow-story-loop.ts:218`), and the engine does not catch node errors. Both are satisfiable. |
| 6. Out of scope | 13/13 present verbatim. No extras. None was turned into an AC. No story contradicts it. |
| 7. Terminal cleanup | n/a (no removal story; the removals are covered by the build/static-gate note). |
| 8. Modifies | 1/1 path, `story-loop.ts`, with its reason intact. The reason does not start with a comma. |
| 9. Forward-reference drift | 18 symbols re-swept across the ACs and `description`. No near-miss spellings. |

## Minors

1. **AC 47 can only be checked indirectly.** It says "rulings are what `adjudicateResidual` returned", but the test cannot observe that value without a spy. It can be met by comparing against the rulings that the harness advisor's `ruleResidual` answer produces, or against the default hold. No action needed.
2. **Planner warnings about ACs that refer to other ACs by number.** ACs 22-31 say "AC-11's call". Each split keeps its spec tag, and AC-11a (PRD AC 20) is the only call it can mean, so the reference is unambiguous. No action needed.

## History

The first Phase 9 pass (FIX NEEDED, no blockers) was answered by editing `prd.json` by hand:
- Dropped the former AC 52, which tested the engine's `STEP_GRAPH_UNDECLARED_OUTPUT` (`src/step-graph/` is out of scope).
- Dropped the former AC 49, which tested `workflowStage` `closeOnError` (`stage.ts` is out of scope and `stage.test.ts` already covers it).
- Reworded AC 48 to name a concrete seam that throws.
- Reworded AC 51 to "the existing equivalence suite passes unchanged".
