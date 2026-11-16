# Spec Review (Phase 9 only) - chat-polish-and-branch-guard

**Spec:** .nax/features/chat-polish-and-branch-guard/spec.md
**PRD:** .nax/features/chat-polish-and-branch-guard/prd.json (7 stories)
**Phases run:** 1 of 9 (--prd, Phase 9 fidelity only; phases 1-8 not re-run)
**Date:** 2026-11-16
**Verdict:** PASS with minors (one MAJOR carried from the spec, see M1)

Gate: precheck.storySizeGate.maxAcCount 24, maxBulletPoints 12.

## Summary (examined counts)

- Spec ACs to PRD ACs: US-001 5 -> 5, US-002 15 spec -> 24 PRD, US-003 15 -> 19, US-004 13 -> 16, US-005 14 -> 18, US-006 15 -> 22, US-007 6 -> 11. Every spec AC has at least one PRD AC. No grep/file-content rewrites.
- Dependency sets: 7 of 7 match the spec (US-005 -> US-004, US-006 -> US-005, others empty).
- File roles: contextFiles 29 entries checked, expectedFiles 8, modifiedFiles 20 paths (spec 20 distinct paths, PRD 20 entries, each with path and reason, no comma-leading reasons).
- outOfScope: spec 15 bullets, PRD 15 bullets, same text. None became an AC. No per-story prefix needed (all feature-level).
- Meta-ACs / cleanup: US-001 deletion carries the `bun run typecheck` gate note in description, no "does not contain" AC.
- Description bullets: every story at most 2 list lines (US-002 call-site bullets), far under 12.
- Forward-reference spelling re-sweep: `featureBranchRefusal`, `useEscConfirm`, `ESC_CONFIRM_MS`, `_escConfirmDeps`, `ESC_FLUSH_MS`, `_mouseInputDeps`, `exploreAgent`, `EXPLORE_AGENT_NAME`, `EXPLORE_AGENT_DESCRIPTION`, `buildExploreAgentPrompt`, `naxAgentsDir`, `showOutput`, `taskEntry` all byte-identical across spec and PRD ACs.
- AC counts: US-001 5, US-002 24 (AT the cap, not over), US-003 19, US-004 16, US-005 18, US-006 22, US-007 11. All within 24.

## The US-006 / US-007 hand split

Spec US-006 has 15 ACs, US-007 has 6 (21 total). PRD US-006 has 22, US-007 has 11 (33 total). The 33 is atomic splitting of the original compound ACs, not additions.

US-006 mapping (spec AC -> PRD index): 1 -> 0,1; 2 -> 2; 3 -> 3,4; 4 -> 5; 5 -> 6; 6 -> 7,8; 7 -> 9,10; 8 -> 11; 9 -> 12; 10 -> 13,14,15; 11 -> 16; 12 -> 17,18; 13 -> 19; 14 -> 20; 15 -> 21. Nothing lost, nothing duplicated.

US-007 mapping: 1 -> 0,1; 2 -> 2,3; 3 -> 4,5; 4 -> 6,7; 5 -> 8,9; 6 -> 10. Nothing lost, nothing duplicated.

Fields:
- dependencies: US-006 `["US-005"]` matches spec; US-007 `[]` matches spec "No dependencies".
- contextFiles: US-006 4 (ChatApp.tsx, esc-layer.ts, useChatKeys.ts, chat-app-esc-layers.test.tsx) and US-007 2 (mouse-input.ts, mouse-input.test.ts) equal the spec lists.
- expectedFiles: US-006 esc-confirm.ts + chat-esc-confirm.test.tsx; US-007 mouse-input-esc-prefix.test.ts. Equal to spec Creates. No self-created file in contextFiles.
- modifiedFiles: US-006 3 (chat-app-keys, chat-app-esc-layers, chat-steering-host) and US-007 1 (mouse-input.test.ts) equal to the spec Modifies, reasons verbatim.
- description: US-006 carries the whole Esc approach, the ref-synchronous arm, the reset-on-turn-end/layer-change rule and the regression list. US-007 carries the hold/flush approach, `ESC_FLUSH_MS = 50`, `_mouseInputDeps`, and the timer-clearing rule. Neither duplicates the other; each names the other under Scope Out.
- suggestedCriteria: planner extras only (US-006 x4, US-007 x1). None contradicts the spec. See m3.

## Findings

### MAJOR

**M1 (spec gap carried into PRD) - US-005 has no modifiedFiles, but `footerHint` gains a required `queued: boolean`.**
- PRD: US-005 has no `modifiedFiles` field; description says "Update required footerHint input fixtures with queued:false if needed".
- Spec: `### Modifies` -> **US-005** "None. The existing steering tests type a non-empty draft... existing footer tests run with an empty queue."
- Reality: `packages/nax/test/unit/tui/chat/chat-status.test.ts` line 23 defines `FOOTER_HINT_INPUT` with no `queued` and spreads it into `footerHint(...)` (line 44, 48, 52). Making `queued` required breaks that fixture at typecheck, and the implementer has no authorisation line to edit the file (the description only says "if needed"). Same exposure for any other direct `footerHint` caller in tests.
- Fix: in the spec add under **US-005** a Modifies bullet for `packages/nax/test/unit/tui/chat/chat-status.test.ts` (FOOTER_HINT_INPUT gains `queued: false`, assertions unchanged), then patch US-005 `modifiedFiles` to match. Or make `queued` optional in the input type and say so in the spec Interface and the US-005 description.

### MINOR

**m1 - US-002 AC 8 literal differs from the spec, in the PRD's favour.** PRD US-002 acceptanceCriteria[8] says `options.jobs.start`; spec US-002 AC 7 says `options.start`. The code (`jobs-launch.ts:94`) uses `options.jobs.start`, so the PRD is correct. Fix: correct the spec literal to `options.jobs.start` so spec and PRD agree.

**m2 - planner-added ACs with no spec AC (all trace to spec prose, none adds scope).**
- US-002 [19] (git exit 1 still reaches approve, card omits branch): spec Failure Handling row 2. [20]-[23] expand AC 7/8/12 over `master` and empty branch; [22] literal `[chat] step 1:` matches `stepError` (`chain-tools.ts:33`).
- US-003 [17], [18]: spec Failure Handling rows 4 and 5 (absent dir, malformed file); `ResourceDiagnostic.origin` exists so the `origin.kind === "nax-user"` assertion is satisfiable. The spec has no AC for these rows (Phase 4 P4.6 class); the planner authored the wording.
- US-004 [14], [15]: right-button no-action, from the spec Modifies note that jobs-opener AC-12 to AC-17 keep their assertions.
- US-006 [3] widens the spec's "2,000 ms" case to "2,000 ms or more ... and a press after the window". This is consistent with the spec Failure Handling row "Second Esc after ESC_CONFIRM_MS arms again".
Fix: none required. Optional: add matching ACs to the spec.

**m3 - suggestedCriteria contain unspecified behaviour** (US-002 nested-repo branch, US-005 "steer throws leaves message available", US-006 "replacement question needs its own two Escapes", US-006 unmount clears timer). Not ACs, not in the spec. If any harness renders suggestedCriteria to the implementer, the US-005 steer-throws item and US-002 nested-repo item could mislead. Fix: none needed unless suggestedCriteria are consumed; otherwise drop those two.

**m4 - US-004 spec Context Files bullet names two paths** (`useChatPicker.ts` ... `picker-model.ts`); only the first reached `contextFiles`. `picker-model.ts` is a read plus an export edit and not listed in any Modifies (sources are not listed by convention here), so no deadlock. Fix (spec): put `picker-model.ts` on its own Context Files bullet.

**m5 - US-002 sits exactly at 24 ACs.** Not over the cap; any planner rerun adding one AC would trip the gate. No action.

**m6 - titles differ from spec headings** (US-006 "Confirm destructive Esc" vs "a running turn stops on a second Esc"). Cosmetic. The spec US-006 heading is also stale after the split ("Esc confirm and split mouse prefix" appears only in Approach).

### Not findings
- No BLOCKER: no dropped or degraded AC, no dependency drift, no self-Creates file in contextFiles, no out-of-scope inversion, no modifiedFiles path missing from the PRD.
- Spec-level concerns outside Phase 9 (e.g. other tests that press Escape during a running turn; I only found the three the spec lists plus approval-only Escape tests in ask-card.test.tsx, which are unaffected) were not audited further.
