# nax chat TUI UX audit

Date: 2026-11-11  
Build inspected: nax 0.92.0  
Model: `opencode-go/deepseek-v4.1-flash`  
Method: live tmux interaction, source review, and automated tests using the ui-ux-pro-max skill.

## Scope

Reviewed the existing React/Ink chat interface for terminal readability, keyboard discoverability, help content, and status feedback. Live checks included 100×30, 60×20, 40×16, 40×20, and 80×24 terminal sizes. Two model turns completed successfully, one before and one after the improvements.

This was a focused usability pass. It did not establish complete accessibility compliance or measure contrast across terminal themes.

## Findings and implemented improvements

### 1. Narrow footers hide important controls and cost

**Priority: High · Status: Fixed**

At 40 columns, the footer rendered its left and right text blocks without budgeting their combined width. The model name competed with the interruption hint and cost, producing fragments such as `guarded · esc to` and hiding the spend.

The footer now fits its content before Ink renders it. Active gestures take priority over duplicated model metadata, which remains available in the header. Secondary information is reduced as space runs out; extremely small panes may omit cost to preserve the active gesture.

At 40 columns with the sandbox available, a running turn now shows:

```text
⏵ guarded · esc to interrupt       $0.00
```

Job-strip click detection receives the fitted strip width and right-side content, keeping clickable cells aligned with the displayed strip.

### 2. Working status overflows on narrow terminals

**Priority: Medium · Status: Fixed**

The working row combined the phase, elapsed time, token estimates, and escape hint. At 40 columns, its text exceeded the allocated row and the interruption hint was clipped.

When the full row cannot fit, it now shows the phase and elapsed time within the available width. The footer carries the active escape action. For example:

```text
✻ Thinking… (5s)
```

### 3. Help is overwhelmed by resource descriptions

**Priority: Medium · Status: Improved**

In the inspected environment, `/help` appended descriptions for 31 commands and 63 skills. Long descriptions occupied much of the transcript, pushing built-in commands and controls out of view.

Help now retains the built-in command list and summarizes the resource catalog:

```text
31 commands · 63 skills — type / to search; /skills for details
```

Commands and skills remain discoverable through the searchable slash menu. `/skills` retains the detailed skills listing. Help remains scrollable when it exceeds the viewport.

### 4. Keyboard capabilities are difficult to discover

**Priority: Medium · Status: Improved**

The idle footer advertised permission-mode cycling, while `/help` documented steering but omitted several existing keyboard controls.

The idle footer now advertises `/ commands`, retaining the mode-cycling hint where space permits. Help includes a keyboard reference for:

- Sending messages and inserting newlines.
- Scrolling the transcript and jumping to the latest content.
- Expanding details and opening jobs.
- Cycling permission mode and reasoning effort.
- Closing overlays, interrupting turns, quitting, and steering.

The documented actions were checked against the existing key handlers.

## Implementation

| File | Change |
| --- | --- |
| `packages/nax/src/tui/chat/status-layout.ts` | Fits footer and working-row content to terminal width. |
| `packages/nax/src/tui/chat/ChatApp.tsx` | Uses the fitted status models for rendering and job-strip interaction. |
| `packages/nax/src/tui/chat/help-text.ts` | Defines keyboard help and the resource summary. |
| `packages/nax/src/tui/chat/slash-commands.ts` | Composes concise help instead of appending all resource descriptions. |

Regression tests cover narrow footers, overlay escape hints, armed quit feedback, wide job names, sandbox warnings, job-strip click boundaries, working-row fitting, and the revised help content.

## Verification

- Live model responses succeeded before and after the changes using `opencode-go/deepseek-v4.1-flash`.
- Live tmux inspection confirmed that interruption feedback and cost remain visible together at 40 columns with the sandbox available.
- `bun run typecheck` passed in `packages/nax`.
- `bun run check:all` passed in `packages/nax`.
- `bun run test` passed all unit, integration, and UI phases in `packages/nax`.
- `bun run test:coverage` passed: 28,610 tests passed, 43 skipped, and zero failed; line coverage was 97.06% and function coverage was 95.50%.
- `git diff --check` passed.
- A separate source review found no important correctness or UX issues in the changes.

The validation above applies to the nax package. A full monorepo test run was not performed. The implementation was left uncommitted after verification.
