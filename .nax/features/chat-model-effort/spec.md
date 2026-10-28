# SPEC: chat-model-effort — switch reasoning effort from the chat and always see it

## Summary

A native model id can carry a reasoning-effort suffix, `opencode-go/deepseek-v4.1-flash[high]`;
`parseNativeModel` strips it and sends it as the thinking level. In `nax chat` the only way to
change the effort is to type a whole id with a different suffix into `/model <id>`, and the screen
hides which effort is active: at 120 columns the header and footer both read
`deepseek-v4.1-flash[hig…`.

This feature adds effort switching and makes the active effort always visible:

- in the `/model` picker, ←/→ cycles the highlighted model's effort (the row reads `deepseek-v4.1-flash  effort high`)
  and Return applies model and effort together;
- a new `/effort` command changes only the effort: `/effort high` directly, or `/effort` alone
  opens a picker of levels;
- the header and footer keep the `[effort]` suffix whole wherever the line fits; the header shows
  the model name in full when the line has room.

It is the second of three chat-polish features split from the 2026-10-28 TUI bug check (after
chat-resume-sessions, before chat-transcript-polish). Every Baseline below assumes
chat-resume-sessions has merged: its header title segment and `headerTitleLine(state, version,
width, glyphs)` signature exist.

## Motivation

Observed in a 120x36 tmux probe of `nax chat` v0.91.7-canary.6 (2026-10-28):

- `shortModel` (`packages/nax/src/tui/chat/chat-status.ts`) cuts any name longer than 24
  characters to 23 plus `…`. Both the header (`headerTitleLine`) and the footer (`rightLine`) use
  it, so `deepseek-v4.1-flash[high]` (25 characters) shows as `deepseek-v4.1-flash[hig…` — the
  effort, the part that changes, is the part removed. The header has a whole row to spare.
- The `/model` picker lists ids exactly as configured (`tierModels` plus catalog discovery), so a
  model is offered only at the suffixes that happen to be configured, and changing effort means
  retyping the id.
- The user asked for effort switching from the TUI (2026-10-28 ruling: picker ←/→ plus `/effort`).

## Design

### Approach

1. **Effort helpers** (pure, new `packages/nax/src/chat/chat-effort.ts`). The levels a user can pick
   are `default` (no suffix — the provider's default) followed by nax-agent's `THINKING_LEVELS` in
   their declared order: `off, minimal, low, medium, high, xhigh, max`. `modelEffort(model)` reads
   the suffix with `parseModelSpec`; `withEffort(model, level)` rewrites it (`default` removes it);
   `cycleEffort(level, step)` moves one level left or right and wraps.
2. **Display.** `shortModel` keeps a trailing `[effort]` suffix whole and elides only the name in
   front of it. The header's model segment drops the 24-character cap. When the first line does not
   fit, the product, version and mode stay fixed, the session title (from chat-resume-sessions)
   yields first, shrinking to nothing, and only then is the model's name elided, its suffix kept
   whole; with no room left for any of the name, the name collapses to the ellipsis alone and the
   suffix still follows it. A name with no suffix is elided at its end the same way. The header
   uses the theme's `glyphs.ellipsis` (`...` in the ASCII theme); `shortModel` keeps its literal
   `…`.
3. **`/model` picker.** Rows are de-duplicated by base model (the id without its suffix), in the order
   their first occurrence appears; a row's `value` is the base model, its `label` is
   `displayText(base)`, and the typed query filters on the base model (so typing `high` no longer
   matches a `[high]` suffix — intended). Each row remembers its original id (the current session
   model for the current row, else its first-seen id) and shows `effort <level>` in its detail
   column, where the level is that id's suffix text as written (`effort turbo` for an unknown
   suffix) or `default`. The pending efforts live in `useChatPicker`'s picker state, keyed by base
   model, and `choose` reads them synchronously the way it reads the pointer, so a →
   and a Return delivered in one input batch apply the cycled effort. ←/→ cycles the highlighted
   row's pending effort through `EFFORT_LEVELS` (an unknown suffix cycles as if it were `default`);
   Return switches to the row's original id when its effort was never cycled, else to
   `withEffort(base, pending)`.
4. **`/effort`.** A new built-in after `model` in `COMMANDS`. `/effort <level>` switches to
   `withEffort(current model, level)`; `/effort` with no argument opens a new `effort` picker whose
   rows are the eight levels with the current one marked `(current)`.

### Integration (extends existing code)

Read only (verified 2026-10-28):

- `parseModelSpec(raw): { model; effort? }` (`@nathapp/nax-agent`, `packages/nax-agent/src/cost/model-spec.ts`) —
  matches `<model>[<effort>]` where neither part contains a bracket.
- `THINKING_LEVELS: Record<ThinkingLevel, true>` (`@nathapp/nax-agent/internal`,
  `packages/nax-agent/src/native/models.ts`) — keys in order `off, minimal, low, medium, high, xhigh, max`.
- `ChatHost.switchTo({ mode?, model? })` and `ChatHost.current().model` (`packages/nax/src/chat/chat-host.ts`) —
  `switchTo` returns without reopening when mode and model are unchanged.
- `useChatPicker`, `pickerModel`, `pickerLayout`, `PickerEntry` (`packages/nax/src/tui/chat/Picker.tsx`).
- `runSlashCommand` (`packages/nax/src/tui/chat/slash-commands.ts`).

Changed — the **Baseline** only locates the code; implement the **Target**.

- `shortModel` (`packages/nax/src/tui/chat/chat-status.ts`)
  - Baseline: the text after the last `/`, cut to 23 characters plus `…` when longer than 24.
  - Target: the same text, but when it ends in `[<effort>]` the suffix is kept whole and only the
    part before it is cut, so the result is at most 24 characters plus the suffix length when the
    name alone exceeds 24, and is unchanged otherwise.
- `headerTitleLine` (`packages/nax/src/tui/chat/chat-status.ts`)
  - Baseline: `shortModel(state.model)`.
  - Target: the text after the last `/` with no length cap, elided in its name part (suffix kept)
    only when the first line would exceed the header width.
- `PickerKind` (`packages/nax/src/tui/chat/slash-commands.ts`)
  - Baseline: `"model" | "resume" | "mode"`
  - Target: `"model" | "resume" | "mode" | "effort"`
- `PickerEntry` (`packages/nax/src/tui/chat/Picker.tsx`) — the model picker's rows take
  `value` = base model and gain `original?: string` and `effortLabel?: string`; the detail column
  shows `effort <effortLabel>`.
- `TITLES` (`Picker.tsx`, `satisfies Record<PickerKind, string>`) gains `effort: "Reasoning effort"`.
- `pickerModel` gains an `effort` branch: rows are `EFFORT_LEVELS` in order, the row equal to
  `modelEffort(currentModel)` marked current; the branch takes no query (like `mode`). The
  function's final branch no longer treats every other kind as `resume`.
- `actionFor` gains an `effort` case: `host.switchTo({ model: withEffort(host.current().model,
  entry.value) })`, reading the host's model at choose time.
- `headerTitleLine` (`chat-status.ts`) — Baseline is the post-chat-resume-sessions
  `headerTitleLine(state, version, width, glyphs)` with its title span; the Target keeps that
  signature and applies the yield order above.
- `ownsPickerKey` (`packages/nax/src/tui/chat/Picker.tsx`)
  - Baseline: `ownsPickerKey(key)` — escape, return, up, down.
  - Target: `ownsPickerKey(key, kind)` — also left and right when `kind` is `model`.
- `ChatPicker` (returned by `useChatPicker`) gains `cycle(entry: PickerEntry, step: 1 | -1): void`;
  `PickerProps` gains `onCycle?: (entry: PickerEntry, step: 1 | -1) => void`, which `Picker`'s key
  handler calls on ←/→ for a model row.
- `PickerState` gains `pending: ReadonlyMap<string, EffortLevel>` (base model -> cycled level) for
  rendering; `useChatPicker` also keeps a ref mirror of that map, written by `cycle` and read by
  `choose`, so a `→` and a Return in one input batch — and repeated `→→` — read the latest level
  rather than the render's state. A cycle starts from the ref's level for that base, else from the
  row's effort label (`default` for an unknown suffix).
- `PickerModelInput` gains `pending?: ReadonlyMap<string, EffortLevel>`; `pickerModel` sets a model
  row's `effortLabel` to the pending level when one exists, and sets
  `detail = "effort " + effortLabel`, so `entryRow` draws it like any other detail.
- `COMMANDS` / `COMMAND_DESCRIPTIONS` — `"effort"` inserted right after `"model"`, described
  `"Switch reasoning effort"`.

New: `packages/nax/src/chat/chat-effort.ts` exporting `EFFORT_LEVELS`, `type EffortLevel`,
`isEffortLevel(text)`, `modelEffort(model)`, `withEffort(model, level)`, `cycleEffort(level, step)`,
re-exported from `packages/nax/src/chat/index.ts`.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `/effort <x>` with `x` not one of the eight levels | no switch; the command shows `unknown effort "<x>"; use one of: default, off, minimal, low, medium, high, xhigh, max`, echoing `x` as typed. The command lowercases its argument before calling `isEffortLevel`, which itself matches exactly |
| `/effort` with more than one argument | no switch; the command shows `usage: /effort [level]` |
| `/effort <level>` equal to the current effort | `switchTo` is called with the unchanged model and returns without reopening; nothing else happens |
| a model id whose suffix is not a known level (`m[turbo]`) | `modelEffort` returns `default`; `withEffort` replaces the unknown suffix |
| `switchTo` rejects (provider unknown, open fails) | the picker or command shows the error the same way `/model <id>` does today |

## Out of Scope

- Validating whether a given provider or model honours a thinking level; an unsupported level still reaches the provider, which `toThinkingLevel` already logs and ignores.
- A notice in the transcript after a model or effort switch (feature chat-transcript-polish).
- Persisting a per-model preferred effort across sessions; the session meta keeps the chosen model id with its suffix, as today.
- Changing effort for a subagent run (`agent.modelAliases`) or for `nax run`.
- Any change to `@nathapp/nax-agent`.
- Bounding the length of an `[effort]` suffix: `parseModelSpec` accepts any non-bracket text, and an unusually long configured suffix is drawn whole.

## Stories

### US-001 — effort helpers

Workdir: packages/nax. No dependencies.

New `packages/nax/src/chat/chat-effort.ts` with `EFFORT_LEVELS`, `EffortLevel`, `isEffortLevel`,
`modelEffort`, `withEffort` and `cycleEffort`, exported through the chat barrel.

### US-002 — keep the effort visible in the header and footer

Workdir: packages/nax. Depends on US-001.

`shortModel` keeps a trailing `[effort]` whole; the header's model segment is uncapped and elided
by the line's width, suffix kept.

### US-003 — cycle a model's effort in the `/model` picker

Workdir: packages/nax. Depends on US-001.

Rows de-duplicated by base model with a pending effort each; ←/→ cycles the highlighted row's
effort; Return switches to `withEffort(base, pending)`.

### US-004 — the `/effort` command and its picker

Workdir: packages/nax. Depends on US-001, US-003.

`/effort <level>`, `/effort` opening an `effort` picker of the eight levels, the `COMMANDS` entry
and its description.

### Context Files

**US-001**
- `packages/nax-agent/src/cost/model-spec.ts`
- `packages/nax-agent/src/native/models.ts`
- `packages/nax/src/chat/index.ts`

**US-002**
- `packages/nax/src/tui/chat/chat-status.ts`

**US-003**
- `packages/nax/src/tui/chat/Picker.tsx` — the picker state, `choose`, and the batching notes in its header
- `packages/nax/src/chat/chat-effort.ts` — created by US-001, used here
- `packages/nax/test/ui/chat/picker.test.tsx`

**US-004**
- `packages/nax/test/ui/chat/slash-menu.test.tsx`
- `packages/nax/src/tui/chat/slash-commands.ts`
- `packages/nax/src/tui/chat/Picker.tsx`
- `packages/nax/src/chat/chat-effort.ts` — created by US-001, used here
- `packages/nax/test/ui/chat/slash-commands.test.tsx`

### Creates

**US-001**
- `packages/nax/src/chat/chat-effort.ts`
- `packages/nax/test/unit/chat/chat-effort.test.ts`

### Modifies

**US-001**
- `packages/nax/src/chat/index.ts` — export the effort helpers from the chat barrel so the TUI imports them through it.

**US-002**
- `packages/nax/test/unit/tui/chat/chat-status.test.ts` — add shortModel cases for a suffixed name and header cases for the uncapped model; the existing shortModel cases and the flatten case pass unchanged.

**US-003**
- `packages/nax/test/ui/chat/picker.test.tsx` — model-picker rows now carry the base model as their value and a `effort <level>` detail; fixtures that list the same base model at two suffixes now expect one row, and assertions on a model row's full text gain the `effort <level>` detail.

**US-004**
- `packages/nax/test/ui/chat/slash-menu.test.tsx` — the effort command now sits after the model command, shifting every later built-in down one row: the nine-down-arrow case that expected the plugins row now lands on the skills row (or takes one more press to reach plugins), and the beyond-the-window comment and the thirteen-matches title are updated to the new count.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the help listing and the cases driven by the built-in command list now include the effort command and its description, between the model and sessions commands.

### Seams

- `withEffort` (US-001) is consumed by the `/model` picker (US-003) and `/effort` (US-004), and `cycleEffort` by the `/model` picker only; their ACs enter through the mounted `ChatApp` (typing `/model` or `/effort`) and assert the fake host's `switchTo` received the suffixed model id.
- `shortModel`'s suffix rule (US-002) is reached from the footer and header renderers; US-002's ACs call `footerModel` and `headerLines`, the functions `ChatApp` draws from.

## Acceptance Criteria

### US-001 — effort helpers

- [unit] `EFFORT_LEVELS` equals `["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]`.
- [unit] `isEffortLevel("high")` returns true and `isEffortLevel("turbo")` returns false.
- [unit] `modelEffort("opencode-go/deepseek-v4.1-flash[high]")` returns `"high"`.
- [unit] `modelEffort("minimax/MiniMax-M3")` returns `"default"`.
- [unit] `modelEffort("m/x[turbo]")` returns `"default"`.
- [unit] `withEffort("opencode-go/deepseek-v4.1-flash[high]", "low")` returns `"opencode-go/deepseek-v4.1-flash[low]"`.
- [unit] `withEffort("minimax/MiniMax-M3", "max")` returns `"minimax/MiniMax-M3[max]"`.
- [unit] `withEffort("opencode-go/deepseek-v4.1-flash[high]", "default")` returns `"opencode-go/deepseek-v4.1-flash"`.
- [unit] `withEffort("m/x[turbo]", "high")` returns `"m/x[high]"`.
- [unit] `withEffort` keeps every slash of a multi-slash id: `withEffort("huggingface/MiniMaxAI/MiniMax-M2.7", "low")` returns `"huggingface/MiniMaxAI/MiniMax-M2.7[low]"`.
- [unit] `cycleEffort("high", 1)` returns `"xhigh"` and `cycleEffort("high", -1)` returns `"medium"`.
- [unit] `cycleEffort("max", 1)` returns `"default"` and `cycleEffort("default", -1)` returns `"max"`.

### US-002 — keep the effort visible in the header and footer

- [unit] `shortModel("opencode-go/deepseek-v4.1-flash[high]")` returns `"deepseek-v4.1-flash[high]"`.
- [unit] `shortModel` of a name of 30 characters followed by `[high]` returns the first 23 characters, `…`, then `[high]`.
- [unit] `shortModel("abcdefghijklmnopqrstuvwxyz1234")` (no suffix) still returns its first 23 characters followed by `…`.
- [unit] `shortModel("anthropic/claude-sonnet-5-5")` still returns `"claude-sonnet-5-5"`.
- [unit] `footerModel` for a state on `opencode-go/deepseek-v4.1-flash[high]` draws `deepseek-v4.1-flash[high]` in its right side.
- [unit] `headerLines` at width 120 for a state on `opencode-go/deepseek-v4.1-flash[high]` shows `deepseek-v4.1-flash[high]` in the first line with no `…`.
- [unit] `headerLines` at width 120 for a model whose name is 40 characters shows the whole name in the first line.
- [unit] `headerLines` at width 40 for a model whose name is 40 characters plus `[high]` keeps the first line within 40 display columns and still ends the model segment with `[high]`.
- [unit] `headerLines` at width 60 for a model whose name is 40 characters plus `[high]` and a non-null session title keeps the first line within 60 columns, drops the title segment, and ends the model segment with `[high]`.
- [unit] `headerLines` at a width that leaves no room for any of the model's name draws the model segment as the theme's ellipsis followed by `[high]`.
- [unit] `headerLines` at width 40 for an unsuffixed model whose name is 40 characters keeps the first line within 40 display columns and ends the model segment with the theme's ellipsis.

### US-003 — cycle a model's effort in the `/model` picker

- [unit] `pickerModel({ kind: "model", models: ["p/a[high]", "p/a[low]", "p/b"], currentModel: "p/b", … })` returns two entries with values `"p/a"` and `"p/b"`, in that order.
- [unit] in that model the `p/a` entry has effort label `high` (its first-seen suffix) and the `p/b` entry has effort label `default`.
- [unit] with `currentModel: "p/a[low]"`, the `p/a` entry has effort label `low` and is marked current.
- [unit] `pickerLayout` draws a model row whose effort label is `high` with the detail `effort high`.
- [unit] a model row first seen as `m/x[turbo]` shows the detail `effort turbo`.
- [integration] Return on an un-cycled `m/x[turbo]` row calls `switchTo({ model: "m/x[turbo]" })`, keeping the id as configured.
- [integration] `→` and Return delivered in one input batch on a row at `high` call `switchTo` with that base at `xhigh`.
- [integration] typing the query `high` in the model picker keeps only rows whose base model contains `high`, not rows whose suffix is `[high]`.
- [integration] in a mounted `ChatApp`, typing `/model`, then →, then Return on the first row calls the fake host's `switchTo` with `{ model: withEffort(<first row base>, cycleEffort(<its effort>, 1)) }`.
- [integration] ← on the highlighted row then Return calls `switchTo` with the level one step lower.
- [integration] → on one row, ↓ to the next row, then Return switches to the second row at its own initial effort; the first row's change is not applied.
- [integration] ←/→ while the picker filters by a typed query cycles the effort and leaves the query text unchanged.
- [integration] ←/→ in the `/resume` picker changes nothing and does not call `switchTo` or `resume`.
- [integration] a rejected `switchTo` from the model picker shows its error in the transcript, as `/model <id>` does.

### US-004 — the `/effort` command and its picker

- [unit] `COMMANDS` lists `"effort"` immediately after `"model"`, and `COMMAND_DESCRIPTIONS.effort` is `"Switch reasoning effort"`.
- [integration] typing `/effort high` in a mounted `ChatApp` whose host is on `p/m[low]` calls `switchTo({ model: "p/m[high]" })`.
- [integration] `/effort default` on `p/m[low]` calls `switchTo({ model: "p/m" })`.
- [integration] `/effort turbo` calls no `switchTo` and shows `unknown effort "turbo"; use one of: default, off, minimal, low, medium, high, xhigh, max`.
- [integration] `/effort` with no argument opens a picker titled `Reasoning effort` with eight rows in `EFFORT_LEVELS` order and the current level marked `(current)`.
- [integration] choosing `xhigh` in that picker on host model `p/m[low]` calls `switchTo({ model: "p/m[xhigh]" })`.
- [integration] escape in the effort picker closes it without calling `switchTo`.
- [integration] `/effort HIGH` is treated as `high` (the command lowercases its argument) and calls `switchTo({ model: "p/m[high]" })` on host model `p/m`.
- [integration] `/effort high now` calls no `switchTo` and shows `usage: /effort [level]`.
- [integration] choosing a level in the effort picker never calls `host.resume`.
- [integration] `/effort high` whose `switchTo` rejects shows the rejection's message in the transcript and leaves the host on its model.
- [integration] the slash menu opened by typing `/eff` offers `/effort` with the description `Switch reasoning effort`.
