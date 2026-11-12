# SPEC: Chat footer fit hardening

## Summary

Harden the narrow-terminal footer, working row and `/help` changes from the 2026-11-11 chat TUI UX audit (`docs/reviews/20261111-nax-chat-tui-ux-audit.md`). The fitter stops reverse-engineering `footerModel`'s display strings and span positions and instead drops footer segments by role, in one declared order. Cost then stays visible at 40 columns whatever the sandbox state, and a gesture is never cut without an ellipsis. The working row reuses the existing elapsed-time logic. `/help` names the keyboard controls the audit missed, and the resource summary reads correctly for empty and singular catalogs.

## Motivation

The audit's fixes are committed on branch `fix/chat-tui-narrow-footer-help` (`6c3ec8d0b`) as `packages/nax/src/tui/chat/status-layout.ts` and `help-text.ts`; that commit is this spec's baseline. Probing `fittedFooterModel` across hints, widths and sandbox states left these defects:

1. **Cost lost whenever the sandbox is not available.** At 40 columns, `busy` with `sandbox unavailable` renders `esc to interrupt · sandbox unavailable` and no cost. `sandbox off` renders `esc to interrupt · sandbox off` and no cost. The audit's "cost remains visible at 40 columns" holds only for an available sandbox. The fitter tries exactly two left variants and never shortens the sandbox warning.
2. **Gestures cut mid-word.** At 30 columns, the `background` hint renders `esc to interrupt · ctrl+b to b`. At 24 columns, `busy` with `sandbox unavailable` renders `esc to interrupt · sandb`. The last-resort `cutSpans` call truncates without an ellipsis, and a cut keybinding hint is misleading.
3. **Trailing separator residue.** At 40 columns, `background` plus `sandbox unavailable` renders `esc to interrupt · ctrl+b to background ` with a trailing space.
4. **The fitter is coupled to display text.** `fittedFooterModel` finds the idle hint by exact text (`span.text === "shift+tab to cycle"`). It removes the model by span index (`footer.right.slice(0, 1)`, `slice(3)`, `slice(-1)`), drops the mode with `compact.slice(2)`, and strips separators with `/^ · /`. Changing `HINT_TEXT.idle` or the span order in `rightLine`/`leftLine` breaks the fitting with no error.
5. **The working row repeats the elapsed-time logic.** `fittedWorkingLine` re-derives the seconds with its own `Date.parse` and lacks `elapsedMs`'s non-finite `nowMs` guard. It also assumes the detail is the line's last span.
6. **Help omits existing keys.** `CHAT_KEYBOARD_HELP` leaves out `home`, `shift+up`/`shift+down` (`TranscriptViewport`), `ctrl+b` (`useChatKeys` `moveForeground`) and `ctrl+v` (`ChatApp` `CTRL_V`).
7. **The resource summary is malformed.** With no catalog it prints `0 commands · 0 skills — type / to search; /skills for details`, and with one command it prints `1 commands`.

## Design

### Integration

Symbols this feature reads (verified, unchanged):

- `packages/nax/src/tui/chat/wrap.ts`: `spansWidth(spans: readonly Span[]): number`, `cutSpans(spans: readonly Span[], columns: number): StyledLine`.
- `packages/nax/src/tui/chat/use-jobs-opener.ts`: `footerStripHit({ x, y, footerRow, columns, rightWidth, stripWidth })`. Its caller in `useJobsOpener` passes `spansWidth(footer.right)` and `footer.stripWidth` from the footer the screen renders.
- `packages/nax/src/tui/chat/theme.ts`: `ChatGlyphs.ellipsis` (`"…"` Unicode, `"..."` ASCII).
- `packages/nax/src/tui/chat/chat-status.ts`: `FooterHint`, `FooterJob`, `FooterTask`, `formatJobStrip`, the private `HINT_TEXT`, `elapsedMs`, `sandboxSpan`, `modeSpan`, `costSpan`.
- `packages/nax/src/tui/chat/context-span.ts`: `contextSpan(state, status): Span | undefined`, imported by `chat-status.ts`.

Symbols this feature changes. Each **Baseline** exists only to locate the code; it is never the interface to implement.

- `footerSegments` (new, `chat-status.ts`).
  Baseline: none.
  Target: `export function footerSegments(input: Parameters<typeof footerModel>[0]): { left: readonly FooterSegment[]; right: readonly FooterSegment[] }`, where `export interface FooterSegment { readonly role: FooterRole; readonly span: Span }` and `export type FooterRole = "mode" | "gesture" | "gestureExtra" | "sandbox" | "strip" | "model" | "context" | "cost"`. A segment's `span.text` never carries a leading ` · ` separator; the fitter joins segments with ` · `.
- `footerModel` (`chat-status.ts`).
  Baseline: `footerModel(input): { left: StyledLine; right: StyledLine; stripWidth: number }`.
  Target: same signature and same output for every input; its `right` plain text equals the `footerSegments` `right` texts joined with ` · `. Its `left` is not re-derived from `footerSegments`, because the idle `/ commands` gesture exists only in the fitted footer.
- `fittedFooterModel` (`status-layout.ts`).
  Baseline: `fittedFooterModel(input & { width: number })`, which rewrites spans by text match and index.
  Target: same signature and return shape `{ left: StyledLine; right: StyledLine; stripWidth: number }`, computed from `footerSegments` by the drop pipeline below. Neither the source text nor the span index of any segment may influence the result.
- `workingLine` (`chat-status.ts`).
  Baseline: `workingLine(status, nowMs, glyphs, escHint = ESC_INTERRUPT): StyledLine | undefined`.
  Target: `workingLine(status, nowMs, glyphs, escHint = ESC_INTERRUPT, width?: number)`. When `width` is given and the full line is wider, it returns the spinner, verb and ` (Ns)` built from `elapsedMs`. If that is still wider than `width`, the end is elided with `glyphs.ellipsis`.
- `fittedWorkingLine` (`status-layout.ts`).
  Baseline: re-derives seconds itself.
  Target: `fittedWorkingLine(status: TurnStatus, now: number, glyphs: ChatGlyphs, hint: string | undefined, width: number): StyledLine | undefined`, with explicit parameters instead of the `Parameters<typeof workingLine>` tuple spread. It returns `workingLine(status, now, glyphs, hint, width)`. The narrow working row drops the token count and the esc hint; the footer carries the esc action.
- `CHAT_KEYBOARD_HELP` and `resourceHelp` (`help-text.ts`). Targets are under Help below.

`ChatApp.tsx` currently imports `fittedFooterModel as footerModel` and `fittedWorkingLine as workingLine`. The implementer may import them under their own names. This is not required.

### Footer drop pipeline

`fittedFooterModel` starts from every segment of `footerSegments` and applies these steps in order. It stops at the first state where `width(left) + width(right) + (right empty ? 0 : 2) <= width`:

1. Drop `model`.
2. Drop `context`.
3. Replace the `strip` segment with the job summary `N active (ctrl+g)` (N = jobs + tasks). `stripWidth` becomes the summary's width.
4. Drop the job summary (`stripWidth` 0).
5. Drop `gestureExtra`.
6. Drop a `sandbox off` segment. The header still states `sandbox off`; the warning `sandbox unavailable` is never dropped here.
7. Drop `mode`.
8. Replace a `sandbox unavailable` segment with its short form `sandbox n/a`, keeping its warning color.
9. Drop `cost`.
10. Last resort: `right` is empty, and `left` is the remaining segments joined and elided at the end to `width` with `glyphs.ellipsis`.

For the `quit` hint, `footerSegments` returns `left` as a single `gesture` segment with the warning quit text and the usual `right` (strip, model, context, cost), as `footerModel` does today. The pipeline treats it like any other hint.

Unless an acceptance criterion says otherwise, fixtures use mode `guarded`, model `opencode-go/deepseek-v4.1-flash`, `costUsd: 0.42`, no jobs, no tasks, no `contextTokens`, no `contextWindow`, Unicode glyphs, and a `TurnStatus` spread over `IDLE_STATUS`.

How hints split into segments:

| hint | `gesture` | `gestureExtra` |
| --- | --- | --- |
| `idle` | `/ commands` | `shift+tab to cycle` |
| `background` | `esc to interrupt` | `ctrl+b to background` |
| `backgroundTmux` | `esc to interrupt` | `ctrl+b ctrl+b to background` |
| any other | the existing hint text | none |

Expected results at 40 columns with `costUsd: 0.42`:

| hint | sandbox | left | right |
| --- | --- | --- | --- |
| `busy` | available | `⏵ guarded · esc to interrupt` | `$0.42` |
| `busy` | unavailable | `esc to interrupt · sandbox n/a` | `$0.42` |
| `busy` | off | `⏵ guarded · esc to interrupt` | `$0.42` |
| `background` | available | `⏵ guarded · esc to interrupt` | `$0.42` |
| `idle` | available | `⏵ guarded · / commands` | `$0.42` |

### Help

Target `CHAT_KEYBOARD_HELP`, joined with `\n`:

```text
Keyboard
enter  send · shift+enter / alt+enter  newline
pgup/pgdn  scroll page · shift+up/down  scroll line · home/end  top/latest
ctrl+o  expand/collapse details · ctrl+g  jobs
shift+tab  cycle mode · ctrl+t  cycle reasoning effort
ctrl+v  paste image · esc  close overlay or interrupt turn
ctrl+b  move the running command to the background (ctrl+b ctrl+b in tmux)
ctrl+c  quit when idle; interrupt when running (again to quit)
ctrl+s  steer the running turn (or interrupt and send)
```

Target `resourceHelp(commands: number, skills: number): string | undefined`:

- Both counts are 0: returns `undefined`, and `formatHelp` omits the line.
- Otherwise: `<commands> command(s) · <skills> skill(s) — type / to search; /skills for details`, singular when the count is 1, for example `1 command · 2 skills — …`.

### Failure Handling

The footer must never render wider than `width`. The help changes have no failure paths.

| Condition | Behaviour |
| --- | --- |
| `width` below 1 or not an integer | Treated as `Math.max(1, Math.floor(width))`, as today. |
| Remaining segments wider than `width` after step 9 | Step 10 elides with `glyphs.ellipsis`; never a bare cut. |
| `nowMs` or `startedAt` not finite in `workingLine` | Elapsed is 0 seconds, via `elapsedMs`. |

## Out of Scope

- The header's model elision at narrow widths (`deepseek…` at 40 columns, `…` at 30) is not changed by this feature, even though the fitted footer drops the model on the assumption that the header shows it.
- Retiring the unfitted `footerModel` export, which only tests call once `ChatApp` renders through `fittedFooterModel`, is deferred.
- A separate `/keys` command or a shorter keyboard block on the ACP path is not part of this feature; `/help` keeps one keyboard block on both paths.
- Contrast and color across terminal themes are not measured or changed.
- US-002 only: the job strip is not elided segment by segment; it is replaced whole by the job summary, then dropped.

## Stories

**US-001 — Role-tagged footer segments.** Workdir: `packages/nax`. No dependencies.
Add `footerSegments`, which returns the footer's left and right sides as role-tagged segments with no leading separators. Hints split into `gesture` and `gestureExtra` per the Design table. `footerModel`'s output stays the same.

**US-002 — Fitter reads segments: right-side and extra-hint steps.** Workdir: `packages/nax`. Depends on US-001.
Rewrite `fittedFooterModel` over `footerSegments`, with no text matching or span indexing, implementing pipeline steps 1–5 (model, context, strip to summary, summary, gestureExtra) and stopping at the first fit. Wire the production render through it so a stubbed `footerSegments` shows on the screen.

**US-003 — Fitter left-side steps, short warning and last resort.** Workdir: `packages/nax`. Depends on US-002.
Extend the pipeline with steps 6–10 (sandbox off, mode, `sandbox n/a`, cost, ellipsis elision) and the width normalisation, with the matrix-wide width and trailing-space invariants.

**US-004 — Working row reuses workingLine.** Workdir: `packages/nax`. No dependencies.
Give `workingLine` an optional `width` that keeps the spinner, verb and elapsed seconds from `elapsedMs`, elided with the theme ellipsis. Make `fittedWorkingLine` take explicit parameters and delegate to it.

**US-005 — Complete keyboard help and well-formed resource summary.** Workdir: `packages/nax`. No dependencies.
Replace `CHAT_KEYBOARD_HELP` with the target block. Make `resourceHelp` pluralise correctly and return `undefined` for an empty catalog, with `formatHelp` omitting the line. Restore exact-equality assertions on the full help text.

### Context Files

**US-001**
- `packages/nax/src/tui/chat/chat-status.ts` — `footerModel`, `leftLine`, `rightLine`, `HINT_TEXT`, `sandboxSpan`, `modeSpan`, `costSpan`
- `packages/nax/src/tui/chat/context-span.ts` — `contextSpan`

**US-002**
- `packages/nax/src/tui/chat/status-layout.ts` — current fitter to rewrite
- `packages/nax/src/tui/chat/chat-status.ts` — `footerSegments` (created by US-001, consumed here)
- `packages/nax/src/tui/chat/ChatApp.tsx` — the render call site that passes `width`
- `packages/nax/src/tui/chat/use-jobs-opener.ts` — `useJobsOpener` reads the fitted `right` and `stripWidth`
- `packages/nax/src/tui/chat/wrap.ts` — `spansWidth`, `cutSpans`

**US-003**
- `packages/nax/src/tui/chat/status-layout.ts` — the segment-based fitter from US-002
- `packages/nax/src/tui/chat/chat-status.ts` — `footerSegments`
- `packages/nax/src/tui/chat/wrap.ts` — `spansWidth`, `cutSpans`
- `packages/nax/src/tui/chat/theme.ts` — `ChatGlyphs.ellipsis`

**US-004**
- `packages/nax/src/tui/chat/chat-status.ts` — `workingLine`, `elapsedMs`, `workingDetail`
- `packages/nax/src/tui/chat/status-layout.ts` — `fittedWorkingLine`
- `packages/nax/src/tui/chat/wrap.ts` — `cutSpans`, `spansWidth`

**US-005**
- `packages/nax/src/tui/chat/help-text.ts` — `CHAT_KEYBOARD_HELP`, `resourceHelp`
- `packages/nax/src/tui/chat/slash-commands.ts` — `formatHelp`
- `packages/nax/src/tui/chat/useChatKeys.ts` — ctrl+b (`moveForeground`), ctrl+t, shift+tab handlers
- `packages/nax/src/tui/chat/TranscriptViewport.tsx` — pgup/pgdn, shift+up/down, home, end

### Creates

**US-001**
- `packages/nax/test/unit/tui/chat/footer-segments.test.ts`

**US-002**
- `packages/nax/test/unit/tui/chat/footer-fit-pipeline.test.ts`
- `packages/nax/test/ui/chat/chat-app-narrow-footer.test.tsx`

**US-003**
- `packages/nax/test/unit/tui/chat/footer-fit-left.test.ts`

**US-004**
- `packages/nax/test/unit/tui/chat/working-line-fit.test.ts`

**US-005**
- `packages/nax/test/unit/tui/chat/help-text.test.ts`
- `packages/nax/test/ui/chat/chat-help-summary.test.tsx`

### Modifies

**US-001**
- `packages/nax/src/tui/chat/chat-status.ts` — adds `footerSegments`, `FooterSegment` and `FooterRole`; `footerModel` may be re-expressed over the segments but its output must not change.

**US-002**
- `packages/nax/src/tui/chat/status-layout.ts` — `fittedFooterModel` is rewritten over `footerSegments`; its signature and return shape stay the same.
- `packages/nax/test/unit/tui/chat/status-layout.test.ts` — the existing `fittedFooterModel` cases stay as written; the width-fit invariant over 10–120 columns remains.

**US-003**
- `packages/nax/src/tui/chat/status-layout.ts` — adds pipeline steps 6–10 to `fittedFooterModel`.

**US-004**
- `packages/nax/src/tui/chat/chat-status.ts` — `workingLine` gains the optional trailing `width` parameter; callers that omit it get the unchanged full line.
- `packages/nax/src/tui/chat/status-layout.ts` — `fittedWorkingLine` takes explicit parameters and delegates to `workingLine`.
- `packages/nax/test/unit/tui/chat/status-layout.test.ts` — the existing `fittedWorkingLine` calls pass five positional arguments; they stay valid under the explicit-parameter signature and keep asserting `Thinking...`, `12s` and the 40-column width.

**US-005**
- `packages/nax/src/tui/chat/help-text.ts` — `CHAT_KEYBOARD_HELP` becomes the nine-line target block and `resourceHelp` returns `string | undefined`.
- `packages/nax/src/tui/chat/slash-commands.ts` — `formatHelp` omits the resource line when `resourceHelp` returns `undefined`.
- `packages/nax/test/unit/tui/chat/slash-commands-acp.test.ts` — the ACP help case uses `toStartWith`/`toContain`/`toEndWith`. Replace it with exact equality against the built-in lines, an empty line, and the target `CHAT_KEYBOARD_HELP`.
- `packages/nax/test/unit/tui/chat/slash-memory.test.ts` — the help-command case uses `toStartWith`/`toEndWith`. Replace it with exact equality against the full expected help text, ending with the target `CHAT_KEYBOARD_HELP`.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the case "help summarizes catalog commands and points to search" asserts `1 commands · 0 skills`. The new invariant is the singular `1 command · 0 skills`.

### Seams

- `footerSegments` (US-001, new export) is consumed by `fittedFooterModel` (US-002). US-002's seam AC stubs `footerSegments`, mounts `ChatApp`, and asserts the stub's segments are what the footer row shows.

## Acceptance Criteria

### US-001

1. [unit] `footerSegments` with hint `busy` and sandbox `available` returns `left` with roles `["mode", "gesture"]`.
2. [unit] `footerSegments` with hint `busy` and sandbox `available` returns `right` with roles `["model", "cost"]`.
3. [unit] `footerSegments` with `costUsd: 0.42` returns a `cost` segment whose text is exactly `$0.42`, with no leading ` · `.
4. [unit] `footerSegments` with hint `idle` returns a `gesture` segment `/ commands` followed by a `gestureExtra` segment `shift+tab to cycle`.
5. [unit] `footerSegments` with hint `background` returns a `gesture` segment `esc to interrupt` followed by a `gestureExtra` segment `ctrl+b to background`.
6. [unit] `footerSegments` with hint `backgroundTmux` returns a `gestureExtra` segment `ctrl+b ctrl+b to background`.
7. [unit] `footerSegments` with sandbox `unavailable` ends `left` with a `sandbox` segment whose text is `sandbox unavailable` and whose color is `warning`.
8. [unit] `footerSegments` with one job returns `right` beginning with a `strip` segment whose text equals `formatJobStrip(jobs, [])`.
9. [unit] `footerSegments` with no jobs and one task `{ command: "bun test" }` returns `right` beginning with a `strip` segment whose text equals `formatJobStrip([], tasks)`.
10. [unit] `footerSegments` with `status.contextTokens` 1200 returns a `context` segment between `model` and `cost`.
11. [unit] `footerSegments` with hint `quit` returns `left` as one `gesture` segment `press ctrl-c again to quit`.
12. [unit] `footerSegments` with hint `quit` returns `right` with roles `["model", "cost"]`.
13. [unit] For hints `busy`, `expanded`, `clear` and `quit`, with sandbox `available`, `unavailable` and absent, and with zero or one job, the plain text of `footerModel`'s `right` equals the `footerSegments` `right` texts joined with ` · `.

### US-002

1. [unit] `fittedFooterModel` at width 40, hint `busy`, sandbox `available` returns left `⏵ guarded · esc to interrupt`.
2. [unit] `fittedFooterModel` at width 40, hint `busy`, sandbox `available` returns right `$0.42`.
3. [unit] `fittedFooterModel` at width 40, hint `background`, sandbox `available` returns left `⏵ guarded · esc to interrupt` and right `$0.42`.
4. [unit] `fittedFooterModel` at width 60, hint `background`, sandbox `available` returns left `⏵ guarded · esc to interrupt · ctrl+b to background`.
5. [unit] `fittedFooterModel` at width 40, hint `idle`, sandbox `available` returns left `⏵ guarded · / commands` and right `$0.42`.
6. [unit] `fittedFooterModel` at width 60, hint `busy`, sandbox `available`, one job `{ kind: "run", target: "feat", progress: { passed: 1, total: 3 } }` returns right `run feat 1/3 · $0.42`.
7. [unit] `fittedFooterModel` at width 60, hint `busy`, sandbox `available`, one job `{ kind: "run", target: "feat", progress: { passed: 1, total: 3 } }` returns a `stripWidth` equal to the display width of `run feat 1/3`.
8. [unit] `fittedFooterModel` at width 60, hint `busy`, sandbox `available`, two `run` jobs with 20-character targets and one task `{ command: "bun test" }` returns right `3 active (ctrl+g) · $0.42`.
9. [unit] `fittedFooterModel` at width 60, hint `busy`, sandbox `available`, two `run` jobs with 20-character targets and one task returns a `stripWidth` equal to the display width of `3 active (ctrl+g)`.
10. [unit] `fittedFooterModel` at width 36, hint `busy`, sandbox `available`, three `run` jobs returns a `stripWidth` of 0 and a right of `$0.42`.
11. [unit] `fittedFooterModel` at width 45, hint `busy`, sandbox `available`, `status.contextTokens` 1200 returns left `⏵ guarded · esc to interrupt` and right `$0.42`.
12. [unit] `fittedFooterModel` at width 30, hint `background`, sandbox `available` returns a left whose plain text has no `ctrl+b`.
13. [unit] `fittedFooterModel` with hint `layer`, `layerHint` `shift+tab to cycle` and sandbox `available` at width 40 returns a left containing `shift+tab to cycle` and not `/ commands`.
14. [unit] `fittedFooterModel` with hint `quit`, sandbox `available` at width 40 returns left `press ctrl-c again to quit` and right `$0.42`.
15. [integration] With `footerSegments` stubbed to return `left` of one `gesture` segment `STUB-GESTURE` and `right` of one `cost` segment `STUB-COST`, mounting `ChatApp` at 80x20 renders a last row containing `STUB-GESTURE` and `STUB-COST`.
16. [integration] Mounting `ChatApp` at 40x20 with sandbox `available` and a running turn renders a last row containing `esc to interrupt` and `$0.00`, at most 40 columns wide.

### US-003

1. [unit] `fittedFooterModel` at width 40, hint `busy`, sandbox `unavailable` returns left `esc to interrupt · sandbox n/a`.
2. [unit] `fittedFooterModel` at width 40, hint `busy`, sandbox `unavailable` returns right `$0.42`.
3. [unit] `fittedFooterModel` at width 40, hint `busy`, sandbox `unavailable` returns a left in which the span whose text includes `sandbox n/a` has color `warning`.
4. [unit] `fittedFooterModel` at width 40, hint `busy`, sandbox absent returns left `⏵ guarded · esc to interrupt` and right `$0.42`.
5. [unit] `fittedFooterModel` at width 40, hint `layer`, `layerHint` `esc to deny`, sandbox absent returns a left beginning `⏵ guarded`.
6. [unit] `fittedFooterModel` at width 24, hint `busy`, sandbox `unavailable` returns an empty right.
7. [unit] `fittedFooterModel` at width 24, hint `busy`, sandbox `unavailable` returns a left whose plain text is at most 24 columns wide and ends with `…`.
8. [unit] For every width from 10 to 120, every hint in `idle`, `busy`, `background`, `backgroundTmux`, `expanded`, `clear`, `copied` and `quit`, modes `guarded` and `full`, and sandbox `available`, `unavailable` and absent, `fittedFooterModel`'s left width plus right width plus the 2-column gap (counted only when right is non-empty) is at most the width.
9. [unit] For every width from 10 to 120, every hint in `idle`, `busy`, `background`, `backgroundTmux`, `expanded`, `clear`, `copied` and `quit`, and sandbox `available`, `unavailable` and absent, the plain text of `fittedFooterModel`'s left never ends with a space.
10. [unit] `fittedFooterModel` at width 40.9 returns the same left and right as at width 40 for hint `busy`, sandbox `unavailable`.
11. [unit] `fittedFooterModel` at width 0, hint `busy`, sandbox `available` returns a left whose plain text is at most 1 column wide.
12. [integration] Mounting `ChatApp` at 40x20 with sandbox `unavailable` and a running turn renders a last row containing `sandbox n/a` and `$0.00`, at most 40 columns wide.

### US-004

1. [unit] `workingLine` with `width` 40, status `{ ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "2026-11-11T00:00:00Z", streamedChars: 40 }` and `nowMs` 12 seconds after `startedAt` returns a line whose plain text ends with `(12s)` and is at most 40 columns wide.
2. [unit] `workingLine` with no `width`, status `{ ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "2026-11-11T00:00:00Z", streamedChars: 40 }` and `nowMs` 12 seconds after `startedAt` returns a line whose plain text contains `↓ ~10 tokens` and `esc to interrupt`.
3. [unit] `workingLine` with `width` 12, status `{ ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "2026-11-11T00:00:00Z" }`, Unicode glyphs and `nowMs` 12 seconds later returns a line whose plain text is at most 12 columns wide and ends with `…`.
4. [unit] `workingLine` with `width` 40, status `{ ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "2026-11-11T00:00:00Z" }` and `nowMs` `NaN` returns a line whose plain text contains `(0s)`.
5. [unit] `workingLine` with `width` 40, status `{ ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "now" }` and `nowMs` 5000 returns a line whose plain text contains `(0s)`.
6. [unit] `workingLine` with `width` 40, status `{ ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "2026-11-11T00:00:10Z" }` and `nowMs` at `2026-11-11T00:00:00Z` returns a line whose plain text contains `(0s)`.
7. [unit] `fittedWorkingLine(status, now, glyphs, undefined, 12)` returns the same plain text as `workingLine(status, now, glyphs, undefined, 12)` for status `{ ...IDLE_STATUS, running: true, phase: "thinking", startedAt: "2026-11-11T00:00:00Z" }` with `now` 12 seconds after `startedAt`.

### US-005

1. [unit] `CHAT_KEYBOARD_HELP` equals the nine-line target block in Design § Help, joined with newlines.
2. [unit] `resourceHelp(0, 0)` returns `undefined`.
3. [unit] `resourceHelp(1, 2)` returns `1 command · 2 skills — type / to search; /skills for details`.
4. [unit] `resourceHelp(3, 1)` returns `3 commands · 1 skill — type / to search; /skills for details`.
5. [unit] `runSlashCommand` with `/help` on a host whose catalog is absent shows text with no line containing `commands ·` and ending with the target `CHAT_KEYBOARD_HELP`.
6. [unit] `runSlashCommand` with `/help` on an ACP brain host shows exactly the built-in command lines, an empty line, and the target `CHAT_KEYBOARD_HELP`, joined with newlines.
7. [integration] Submitting `/help` in a mounted `ChatApp` whose catalog has one command and no skills shows `1 command · 0 skills — type / to search` in the transcript.
