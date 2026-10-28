# PRD Fidelity Report — chat-model-effort

**Spec:** `.nax/features/chat-model-effort/spec.md`
**PRD:** `.nax/features/chat-model-effort/prd.json` (`nax plan --profile native-claude`, 2026-10-28)
**Reviewed against:** main `3ad7920ff`
**Phases run:** 9 only (phases 1-8 ran in the two earlier spec reviews)
**Verdict:** READY. 0 blockers, 1 major (sizing risk, not drift), 2 minors.

## Summary

- 9.1 AC mapping: 49/49 spec ACs map to PRD ACs (US-001 12->15, US-002 11->15, US-003 14->19, US-004 12->22). Atomic splits only; no spec AC lost.
- 9.2 Behavioural fidelity: 71/71 PRD ACs are runtime tests (`[unit]`/`[integration]`); 0 rewritten to file-content or grep form. The concrete fixtures the planner added check out: US-003 AC9/11 `p/a[high]` -> `p/a[xhigh]`, AC12 -> `p/a[medium]`, AC13 un-cycled second row -> `p/b[low]`, AC14 `p/high-model` base contains `high`.
- 9.3 Orphan ACs: 4 examined, all traced. US-003 AC14 (detail redraws while filtered) is a split of the spec's query-cycling AC. US-004 AC20/21 (same-effort no-op) and AC22 (picker rejection) come from the spec's Failure Handling rows. None adds material scope.
- 9.3b Dependencies: 4/4 stories match (`[]`, `[US-001]`, `[US-001]`, `[US-001, US-003]`).
- 9.4 File roles: 18 contextFiles + 2 expectedFiles entries checked; every path exists on disk or comes from upstream US-001 (`chat-effort.ts`, kept correctly in the US-002/3/4 contextFiles). No self-created file sits in contextFiles. Additions (minor, useful): US-002 `chat-status.test.ts`, `styled-line.tsx`, `theme.ts`; US-003 `ChatApp.tsx`, `useChatKeys.ts`.
- 9.5 Meta-ACs: none in the spec. 9.5b corrections from earlier reviews: all 6 sampled reach `description` (lowercasing in US-004, `isEffortLevel` exact match, ref mirror for one-batch `→`+Return, theme `glyphs.ellipsis`, choose-time host model, unknown suffix cycles as `default`).
- 9.5c Satisfiability (invocation ACs with existing endpoints): 3 traced. Model and effort picker rejections reach the transcript through `useChatPicker` -> `runControl(() => actionFor(...))` (`Picker.tsx:430`, documented `Picker.tsx:19-20`). `/resume` ←/→ no-op is reachable because `ownsPickerKey(key, kind)` gates left/right to `model`.
- 9.6 Out of scope: 6/6 spec exclusions in `prd.outOfScope`, in order. None inverted into an AC; no story contradicts one. 0 orphan exclusions.
- 9.7 Cleanup story: n/a.
- 9.8 Modifies -> modifiedFiles: 5/5 paths, one entry each, reasons populated, no comma-led reasons.
- 9.9 Forward-reference re-sweep: 11 symbols (`EFFORT_LEVELS`, `EffortLevel`, `isEffortLevel`, `modelEffort`, `withEffort`, `cycleEffort`, `original`, `effortLabel`, `cycle`, `onCycle`, `pending`) spelled identically across all PRD ACs and descriptions.

## Findings

### Major — US-002 test file will breach the 800-line gate

`packages/nax/test/unit/tui/chat/chat-status.test.ts` is 722 lines and is not grandfathered in `file-sizes-baseline.json`. `check:file-sizes` gates `test/**/*.test.ts` at 800. US-002 adds 15 ACs' worth of cases to it, which very likely crosses 800. The description does not say how to stay under the limit (US-003 does say this for `picker.test.tsx`). An unwarned implementer finds out at the gate and spends a fix round splitting the file.
**Fix:** add one sentence to the US-002 description telling the implementer to put the new header cases in a sibling file split by describe block (for example `chat-status-header.test.ts`) when the file would exceed ~650 lines.

### Minor — US-003 `picker.test.tsx` is at exactly 800 lines

`.tsx` tests are outside the `check:file-sizes` scan (`**/*.test.ts`), so this cannot fail the gate, but the 800-line rule in `.nax/rules/` still applies in review. The US-003 description already tells the implementer to factor focused tests. No change needed.

### Minor — US-004 AC21 "the existing session is not reopened"

With the fake host in a mounted `ChatApp`, reopening is not observable; the no-reopen behaviour belongs to the existing `ChatHost.switchTo` equality check. The implementer may write a tautological assertion here. It does no harm, and the spec's Failure Handling row supports it. No change needed.

### Note — US-004 count correction is correct

The planner told US-004 to use 15 commands rather than the spec's "thirteen-matches" wording. `COMMANDS` holds 14 built-ins today (`slash-commands.ts:33-48`), so the test title `AC-10 thirteen matches` was already stale. 15 after the addition is correct.
