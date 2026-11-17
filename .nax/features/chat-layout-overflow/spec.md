# Chat layout overflow and working-status spacing

## Intent

Fix terminal chat frame overflow and stale rows after resize, and give the live Thinking/Writing status one blank row above and below. Feature branch: `feat/chat-layout-overflow`. Plan profile: `native-codex-dsm`. Spec reviewer: `openai-codex/gpt-6-luna`.

This is a presentation and geometry fix, not a change to chat execution, queue draining, steering semantics, or permissions.

## Evidence and current behavior

At repository commit `c0add8c96`, a deterministic host mounted through the actual `renderChat` in an isolated tmux PTY reproduced:

- Start a turn, queue four messages, resize 80x24 -> 80x12 -> 80x24. The header scrolls out at the smaller size; stale transcript/status text remains in its place after expansion and subsequent clock ticks.
- Seventeen unresolved accepted steers overflow an 80x24 frame even without resizing.
- Independent mounted-frame probes find overflow on very short terminals even with no pending messages.

The existing 82 focused layout, input-focus and steer-queued tests pass. Checking only whether a footer string appears in `lastFrame()` is insufficient: the virtual frame can be taller than the terminal.

Relevant implementation:

- `packages/nax/src/tui/chat/ChatApp.tsx`: fixed three-row header, queue/steer preview subtraction, minimum input and viewport floors, working-line rendering and bottom-region composition.
- `message-queue.ts`: queue previews are capped at three items plus an overflow row; steering previews are uncapped.
- `bottom-region.ts`, `ChatInput.tsx`: bottom budgets can fall below the input's actual three-row minimum.
- `TranscriptViewport.tsx`, `selection.ts`, `use-jobs-opener.ts`: viewport/header/footer geometry and hit testing. `FRAME_SLACK_ROWS` is currently one.
- `index.ts`, repository `patches/ink@6.7.0.patch`: incremental renderer and existing cursor-origin patch. Do not assume that patch needs changing; reproduce after fitting the frame first.

## Scope

1. A single, deterministic frame row allocation model shared by measurement, drawing and interaction geometry.
2. Height-aware combined steering/queue previews with truthful overflow counts.
3. Explicit working-status padding above and below.
4. Safe small-terminal behavior and resize recovery.
5. Pure, mounted UI, and real-PTY regression coverage.

Out of scope: streaming drag-selection cancellation (a separate confirmed bug), new queue controls, changes to accepted/discarded steering behavior, model/provider changes, dependency upgrades, broad ChatApp refactoring, release/merge, and new user configuration.

## Required behavior

### R1. Hard frame bounds and one allocation result

For terminal height H >= 2, the rendered frame must use no more than H - 1 physical rows, preserving the existing one-row slack. At H = 1, render at most one non-interactive clipped diagnostic row; no scrolling output. Keep existing fallback dimensions for unavailable/zero terminal dimensions.

Allocate nonnegative integer row counts once and use the same result to render every region and compute viewport top, footer location, visible menus and their key ownership. No independent minimum may increase the sum beyond the usable budget. Text rows must not accidentally wrap beyond their assigned height. Existing supported-width behavior must not regress.

Preserve normal full-height composition: header, transcript, padded live status when present, pending previews, bottom input/overlay, footer. Preserve surface precedence: ask card > picker > input and its menus. Hidden queue/steer previews reserve zero rows when the input is replaced by an overlay. Measurement must include the actual input hint, width, busy state and text-row cap used for drawing.

The allocator should be a small pure helper/module rather than more ad-hoc arithmetic inside ChatApp. Its result must identify the actually visible surface (`input`, `ask`, `picker`, or `diagnostic`), each region's row count and top coordinate, and which keyboard/mouse targets are active within those bounds. Surface minima and desired sizes come from pure component measurement helpers, not duplicated constants in ChatApp. Pass geometry and visibility into interaction consumers; do not introduce a second competing layout model. Diagnostic visibility gates every surface handler, including AskCard, Picker, input, slash/mention menus, viewport selection/scrolling, and the jobs opener. This gating must also cover screen-level shortcuts such as Ctrl-S, Ctrl-V and Ctrl-G; only resize, host events and the existing Ctrl-C cancel/quit path remain active in diagnostic mode.

### R2. Working-status gaps

Whenever the existing live working line is drawn, including Thinking, Writing and other phases using that same component, draw exactly one explicit blank row immediately above and one immediately below it in the normal layout. These are dedicated rows, not an accidental blank last transcript line or top input border. They are not text padding inside the status line.

Example:

```
last transcript row

Thinking… / Writing…

queued/steering previews, input rule, or overlay
```

Reserve both rows in the allocation result. When no live working line exists, reserve and draw neither the line nor its gaps. Phase changes must not make the region jump in height. Gaps may collapse under height pressure, but only as a pair (two or zero). They yield before essential input/overlay controls, footer, or a required status row. They must never reintroduce overflow. At 80x24 with an empty prompt and up to four pending items, both gaps must be visible while a turn runs.

### R3. Bounded pending previews, preserved messages

Steering and queue previews share one height budget; adding separate fixed caps alone is not sufficient for short terminals. Keep the existing group order: pending steers in arrival order, then queued messages oldest first.

Use a normal maximum of four combined preview rows. If all pending items fit, show all of them. Otherwise reserve the final available preview row for `+N pending`, with N equal to all pending items not individually shown across both groups. With one row available and more than one pending item, show only that summary; a single pending item fits and shows its labeled preview. With zero rows, draw nothing and reserve nothing. Each visible item keeps its `steering` or `queued` label. Summary counts items, not text lines. Sanitize/flatten preview text as today and fit each to one physical row.

This is only a projection. Do not truncate stored messages, mutate queue order, resolve steering promises, or change sending/draining on resize. Settling a hidden steer and draining a hidden queued item must update the summary correctly. Pending content returns to the preview when space becomes available. Existing plain return and Ctrl-S behavior is unchanged.

### R4. Small-terminal policy

Use a deterministic degradation policy rather than allowing a sum of region minimums to overflow. The essential set is the current input/overlay minimum, one footer row, and exactly one live status row whenever the existing working-line predicate is true. The live status row is never sacrificed in an interactive layout; diagnostic fallback replaces the whole layout if that essential set cannot fit. Its two gaps are optional and distinct from that row.

For the input surface, begin with the essential set plus the normal three-row header, one transcript row, desired extra input text rows up to the existing editor cap, desired slash/mention rows up to their existing caps, up to four combined preview rows, and the pair of working gaps when busy. If this exceeds usable rows, reduce in this exact order: (1) remove both working gaps, (2) reduce preview rows down to zero, (3) reduce menu rows down to zero, (4) reduce extra input text rows down to zero, leaving its three-row framed minimum, (5) remove the header path and rule together, (6) remove the remaining header row, (7) remove the one reserved transcript row. Thus input text outranks menus, menus outrank previews, previews have no guaranteed minimum, and the gaps yield first. Give any remaining space to the transcript. Recompute from desired sizes on every resize; never persist the degraded counts as desired state.

For ask/picker surfaces use the same ordering with input menus/previews absent; their desired extra body/list/answer rows occupy the same priority slot as extra input text rows. Their pure measurement helpers must expose these safe minima at the actual width:

- Plain input: two rules plus one text row (three rows).
- Picker: its existing fixed frame/title/filter/note rows plus one selected-entry row for a nonempty filtered list. An empty list needs just those fixed rows and cannot choose or stop an entry. Extra entry rows yield down to this minimum.
- Approval/choice ask: top rule, the complete wrapped title/attribution, all rendered option rows, countdown and bottom rule. If command/reason/diff/summary body rows are withheld, also reserve the existing measured elision marker. No option/shortcut may remain actionable while its option row is clipped.
- Question ask: top rule, complete wrapped title, at least the first question-text row, the three-row minimum answer box, countdown and bottom rule; include the measured elision marker if more question text is withheld. Extra answer/body rows yield to this minimum. A blank question retains its empty text row.

These are sizing minima, not permission changes; existing elision semantics and option labels remain. Tests must exercise wrapped titles/options and filtered empty pickers so their measured minima cannot silently disagree with the drawn surface. Never mount a viewport that internally forces a one-row minimum when allocated zero.

If the essential set still exceeds usable rows after the optional regions yield, replace the interactive frame with a height-bounded `Terminal too small — enlarge to continue` diagnostic (clipped to the supported width). This applies to any undersized input or overlay, not just a fixed terminal-height threshold. All surface bounds become inactive in this mode; do not clip an actionable overlay and leave its handlers running.

In the diagnostic fallback, do not accept draft edits, submits, menu choices, approval answers or mouse actions on hidden surfaces. Preserve their state. Keep the existing Ctrl-C cancel/quit path available, including its existing confirmation semantics, and keep host events/resize subscriptions alive. Do not cancel a turn, dismiss an ask, lose a draft/history, or resolve a queued item merely because the terminal shrank. On expansion, restore the current surface and state. Existing externally driven ask expiry remains unchanged.

Input/answer drafts, pending messages, menu/picker state and transcript scroll/follow state must survive a temporary zero-height viewport or diagnostic fallback. Existing behavior for new messages and explicit scroll-to-bottom remains unchanged. Do not remount the entire chat session just to recover drawing.

### R5. Geometry and resize recovery

Derive transcript mouse coordinates, selection/click offsets, footer job-strip hit tests and visible menu key claims from the drawn layout. Compact header/zero viewport must not leave hardcoded three-row offsets behind. A hidden surface must not own keys or clicks. Existing normal-layout interactions stay compatible.

After shrinking and expanding, the complete current frame must be correct: header restored, no ghost Thinking/Writing lines, queue rows or transcript fragments in header/footer space. Re-test with the fitted frame before changing Ink integration. If stale cells persist, implement a scoped resize invalidation/full repaint through the renderer boundary and test it; do not disable incremental rendering for every streaming tick or issue terminal clears from React render. Preserve alternate-screen teardown and terminal restoration.

## Acceptance criteria

- AC1: Pure allocation cases covering heights 1, 4, 5, 8, 9, 10, 12, 24 and 40 always satisfy the frame bound, with no negative allocation. Cover idle/busy, short/long drafts, queue-only, steer-only and mixed pending items, menus, asks and pickers.
- AC2: At 80x24 during a turn, explicit blank rows are immediately above and below the working line, including with four pending items. Thinking -> Writing retains the same region height; ending the turn removes the status region and both gaps.
- AC3: Combined preview counts for 0, 1, 4, 5, 17 and 40 items and budgets 0..4 are exact. An overflow summary fits inside the budget, not beside it. Hidden messages remain in state and retain send/steer order and settlement behavior.
- AC4: Mounted ChatApp frames fit H - 1 for H >= 2 across the height matrix. 80x24 with 17 and 40 unresolved steers does not overflow; 80x12 with four queued messages does not overflow. Assert frame row counts, not just string presence.
- AC5: Very short-terminal fallback preserves a nonempty input/answer draft, pending queue/steers, picker/menu state (including selection/query) and viewport scroll position across shrink/expand. While diagnostic mode is active, Enter, approval shortcuts, slash/mention navigation and choice keys, picker choice/cycle/stop keys, footer job-strip clicks and Ctrl-G, viewport mouse actions, Ctrl-S and Ctrl-V must not mutate those states or trigger host actions. Ctrl-C retains its established behavior. After expansion, assert the same controls act on the restored visible targets. Cover both a running turn and idle input, plus ask, picker, slash and mention surfaces in separate cases.
- AC6: Normal and compact layouts have correct transcript hit tests, footer job-strip clicks, and menu key ownership. Hidden viewport/footer/menu targets cannot activate actions. Ask/picker precedence remains intact.
- AC7: Deterministic real-PTY regression: using the source renderChat and a fake host (no LLM calls), start a turn, queue four messages, resize 80x24 -> 80x12 -> 80x24, and verify the final terminal screen against the expected current frame. Repeat with 17 pending steers and with a tiny-height fallback cycle. Wait for explicit readiness/frame conditions with bounded timeouts, not fragile arbitrary sleeps. Check repeated status ticks and return to idle. Clean up only test-owned processes/sessions/socket paths in finally, including failures.
- AC8: No global incremental-rendering disable, no queued message loss, no changed approval semantics, and no remaining probe processes or production source edits unrelated to this feature. Existing focused UI regressions remain green.

## Verification and implementation boundaries

Follow repository architecture and scoped AGENTS/rules before editing implementation. Use targeted bun tests with explicit paths, then package typecheck/lint and the project's normal pipeline gates. Never run bare `bun test`. Real PTY testing must be capability-gated locally with an explicit skip reason where unavailable, plus documented instructions for running the same check in a PTY-capable environment. Unit/mounted frame assertions must remain mandatory even when PTY support is absent. Do not change coverage floors to accommodate skips.

Suggested work decomposition (planner may refine without weakening criteria):

1. Pure allocation and pending-preview projection with boundary tests.
2. ChatApp integration, working gaps and state-preserving compact/fallback behavior.
3. Geometry/key-ownership integration and mounted regressions.
4. Resize recovery verification, any necessary renderer-boundary correction, and PTY regression/documentation.

The independent streaming-selection bug is not a dependency and must not be bundled into these stories.
