# PRD Fidelity Report: bot-review-depth

**Spec:** `docs/specs/SPEC-bot-review-depth.md` (`94b29c841`)
**PRD:** `.nax/features/bot-review-depth/prd.json` (`97950d0d9`, `nax plan --profile native-claude`)
**Date:** 2026-10-24
**Verdict:** READY. No blockers, no majors, 2 minors (no action needed).

## Summary (examined counts)

- AC mapping: 29/29 spec ACs map to a PRD AC. The PRD has 32 ACs. Differences are whitespace and backticks only.
- Design text blocks: 4/4 are copied verbatim into ACs (US-002 #1 Beyond the diff, US-002 #4 Tests, US-003 #1 green verdict, US-003 #4 approval line).
- Orphan PRD ACs: 3/3 traced; none add scope.
- Dependencies: 4/4 stories match. US-001 `[]`, US-002 `[]`, US-003 `[US-002]`, US-004 `[]`.
- File roles:
  - Context Files: 18 spec entries map to 17 PRD `contextFiles` entries, 0 dropped. US-002's barrel note is folded into a reason, not a separate path.
  - Creates: 3/3 are in US-001 `expectedFiles`.
  - No self-created file appears in `contextFiles`.
- Modifies: 2/2 paths, each with its own `modifiedFiles` entry and a full reason.
- Out of Scope: 12/12 verbatim in `prd.outOfScope`. None became an AC. No orphan exclusions.
- Correction survival: 6/6 review corrections are in a story `description` or AC, not in `analysis`:
  - `_runtimeLoggerDeps`
  - the `getSafeLogger` import
  - `REPLY_TASK` as a function of `conversationOnly`
  - the header comment
  - the review fix "the line directly after"
  - `keepTests`
- PRD-AC satisfiability: 5 invocation ACs traced, all reachable:
  - US-001 #1: `runBotReview:470` to `reviewCheckout` to `deps.createRuntime`.
  - US-001 #2: `runBotFix:456` to `fixCheckout` to `deps.createRuntime`.
  - US-002 #8 and US-004 #6-8: `runPrReview` to `_workflowDeps.callOp`. Existing tests already drive these through the same deps.
- Forward-reference drift: 9 symbols re-swept. Each has exactly one spelling in the PRD.
- Terminal cleanup story: n/a (no removals).

## Orphan PRD ACs (all traced)

| PRD AC | Source in spec |
|---|---|
| US-001 #9: still returns the no-op auditor after emitting the warning | Failure Handling row 1 |
| US-003 #6: red CI verdict unchanged | Design Approach 5 ("The red and no-result verdicts and the fenced detail are unchanged") |
| US-004 #9: an approved verdict with an unread test file is returned unchanged | Failure Handling row 3, and Out of Scope "No code guard turns an approved verdict into changes" |

## Minors

1. **Duplicate assertion in US-004.** US-004 #1 appends "without invoking test-pattern resolution", which duplicates US-004 #3. It is harmless; both tests can share a fixture.
2. **Negative ACs pass before the change.** US-001 #5-8 and US-004 #4-5 assert behaviour that already holds, so they are regression guards rather than fail-first tests. US-001 #3-4 and US-004 #1-3 carry the fail-first signal.
