# SPEC: Choice questions for agent asks in nax chat

## Summary

An agent in nax chat can ask the person one to four structured questions, each with its own
options (single-select or multi-select, every option with an optional description) and an
"Other" free-text answer. nax chat draws these as a choice card. In single-select you move with
the arrows or a number and confirm with Enter. In multi-select you toggle with space. The last
row is "Other...", which opens an inline text box. When the ask has more than one question, the
questions sit on tabs and a final review step comes before submitting. Two sources produce
these asks: the native agent's `ask_human` tool, which gains an optional `questions` argument,
and ACP agents' elicitation forms whose fields are all selects (Claude Code's AskUserQuestion
arrives this way). Today both reach the person as a plain-text question with a numbered list,
and the person has to type `2` or `1, 3`.

## Motivation

- The native `ask_human` tool takes only `{ text }`
  (`packages/nax-agent/src/native/session/ask-human.ts`), so a model that wants a choice has
  to write the options into prose. The person then answers in free text and the model has to
  interpret it.
- `packages/nax-agent-acp/src/client/elicitation.ts` asks a form one field at a time as a text
  question (`questionText` renders `1. label - description` lines plus an instruction), then
  matches the typed reply by number, value or label (`matchChoice`). A multi-select needs
  comma-separated input. A reply that matches nothing declines the whole form
  (`NO_MATCH_NOTE`).
- The chat question card (`AskCardQuestion` in `packages/nax/src/tui/chat/ask-card.ts`) is
  only a text box. The run-ask and host-choice card (`AskCardChoice`) already has arrow and
  number selection. Agent questions do not, and nothing supports multi-select, an Other row
  or several questions in one ask.

## Design

### Data contract (nax-agent, exported from `.`)

New module `packages/nax-agent/src/session/choice-questions.ts`:

```ts
export interface ChoiceOption {
  readonly label: string;
  readonly description?: string;
}
export interface ChoiceQuestion {
  /** Short tab label; cut to CHOICE_HEADER_MAX_CHARS. */
  readonly header: string;
  readonly question: string;
  readonly options: readonly ChoiceOption[];
  readonly multiSelect: boolean;
  /** Whether a free-text "Other" answer is accepted. */
  readonly allowOther: boolean;
  /** Whether the person must answer it; a non-required question may be left empty. */
  readonly required: boolean;
}
export interface ChoiceAnswer {
  /** 0-based option indexes, ascending, unique. */
  readonly selected: readonly number[];
  readonly other?: string;
}
export interface ChoiceAskResult {
  /** What the person's answer reads as: formatChoiceAnswers(...) or the raw text of a plain reply. */
  readonly text: string;
  /** Absent when the embedder answered with a plain { text } reply. */
  readonly answers?: readonly ChoiceAnswer[];
}
export const CHOICE_MAX_QUESTIONS = 4;
export const CHOICE_HEADER_MAX_CHARS = 16;
export function parseChoiceQuestions(
  input: unknown,
  limits: { readonly maxOptions: number; readonly allowOther: boolean },
): { readonly ok: true; readonly questions: readonly ChoiceQuestion[] } | { readonly ok: false; readonly reason: string };
export function validateChoiceAnswers(questions: readonly ChoiceQuestion[], answers: unknown): string | undefined;
export function formatChoiceAnswers(questions: readonly ChoiceQuestion[], answers: readonly ChoiceAnswer[]): string;
export function renderChoiceQuestionsText(prompt: string, questions: readonly ChoiceQuestion[]): string;
```

- `parseChoiceQuestions` accepts an array of 1 to `CHOICE_MAX_QUESTIONS` objects, each with a
  non-empty string `question`, a string `header` (cut to `CHOICE_HEADER_MAX_CHARS` characters;
  an empty or missing header becomes `Q<n>`, 1-based), an `options` array of 2 to
  `limits.maxOptions` objects each with a non-empty string `label` and an optional string
  `description`, and an optional boolean `multiSelect` (default `false`). `allowOther` is
  copied from `limits.allowOther` and `required` is `true`. Option labels must be unique
  within one question (case-insensitive). Any other shape returns `{ ok: false, reason }`. The
  reason names the first failing path, for example
  `questions[1].options: expected 2-8 options, got 1`.
- `validateChoiceAnswers` returns `undefined` for a valid answer list and a reason string
  otherwise. The list is valid when all of these hold:
  - it is an array with exactly one entry per question;
  - every `selected` index is an integer in range, unique and ascending;
  - a single-select entry has at most one selected index, and never both a selected index and
    `other`;
  - `other` is present only when `allowOther` is true, and is then a non-empty string after
    trimming;
  - an entry for a `required` question has at least one selected index or an `other`.

  An entry for a non-required question may be `{ selected: [] }`.
- `formatChoiceAnswers` returns one line per question, joined with `\n`. Each line is
  `<question> -> <labels>`, where `<labels>` is the selected option labels in index order joined
  with `, `, followed by `Other: "<other>"` (joined with `, ` when labels precede it) when
  `other` is set. An empty non-required entry reads `(skipped)`. Example:
  `Which checks? -> lint, tests, Other: "e2e smoke"`.
- `renderChoiceQuestionsText` produces the plain-text rendering every consumer that ignores
  `questions` still shows: `prompt` (when non-empty) and then, per question, the question line
  (prefixed `(n/m) ` when m > 1), numbered option lines `n. label - description` (just
  `n. label` without a description), and the instruction line `Reply with one number or label.`
  (single) or `Reply with numbers or labels, separated by commas.` (multi).

### Session surface (nax-agent)

Symbols the feature changes. The baseline exists only to locate the code and is never the
interface to implement.

- `SessionEvent` `question` variant (`packages/nax-agent/src/session/agent-session-types.ts`).
  Baseline: `{ type: "question"; requestId; text; expiresAt; answerable?: false }`.
  Target: the same plus `readonly questions?: readonly ChoiceQuestion[]` and
  `readonly prompt?: string`, both set only on a choice ask. For a choice ask, `text` carries
  `renderChoiceQuestionsText(prompt, questions)`, so a consumer that reads only `text` (koda,
  the nax-agent ACP server, Telegram) still shows every option.
- `AnswerReply`. Baseline: `{ decision } | { text }`. Target:
  `{ readonly decision: "allow" | "deny" } | { readonly text: string; readonly answers?: readonly ChoiceAnswer[] }`.
- `SessionAskPort` (`packages/nax-agent/src/session/session-backend.ts`). Target: adds the
  optional method `askChoices?(prompt: string, questions: readonly ChoiceQuestion[], opts?: { readonly signal?: AbortSignal }): Promise<ChoiceAskResult | null>`.
  It is optional so the existing nax implementer (`packages/nax/src/agents/acp/ask-port.ts`)
  and test fakes keep compiling.
- `PendingAskTable.issue` (`packages/nax-agent/src/session/pending-asks.ts`). Baseline:
  `issue(kind, signal)`. Target: `issue(kind, signal, validate?: (reply: AnswerReply) => string | undefined)`.
  `answer()` runs `validate` only while the entry is pending, after the kind check. When it
  returns a string, `answer()` throws `AgentSessionError` code `AGENT_SESSION_INVALID_ANSWER`
  with that string in its message and leaves the request pending.
- `createSessionAskPort` (`packages/nax-agent/src/session/session-ask-port.ts`) implements
  `askChoices`. It issues a `question` entry whose validator rejects an `answers` field that
  fails `validateChoiceAnswers`, and emits the `question` event with `questions`, `prompt` and
  the rendered `text`. A human settlement resolves to
  `{ text: formatChoiceAnswers(questions, answers), answers }` when the reply carries
  `answers`, and to `{ text: reply.text }` otherwise. Deadline, cancel and no running turn
  resolve to `null`, as `askQuestion` does today.
- `AdapterInteraction`, the `InteractionHandler` request type (`packages/nax-agent/src/session/interaction-handler.ts`).
  Baseline: `{ kind: "question"; text: string }`. Target:
  `{ kind: "question"; text: string; prompt?: string; questions?: readonly ChoiceQuestion[] }`.
  For a choice ask, `text` is already `renderChoiceQuestionsText(prompt, questions)`, so a
  handler that reads only `text` (`packages/nax/src/agents/run-interaction-handler.ts`) shows
  the options unchanged.
- `answerQuestion` in `packages/nax-agent/src/session/session-interaction.ts` calls
  `deps.asks.askChoices(prompt, questions)` when the request has `questions` and the port has
  `askChoices`, and answers with the result's `text`. Otherwise it keeps today's
  `askQuestion(text)` call. That call already carries the rendered options.
- `src/index.ts` is exactly 600 lines today, which is the source-file cap; `check:file-sizes`
  fails at 601 and nax-agent's baseline grandfathers nothing. Any story that adds names to
  the `.` entry has to keep the file at or under 600 lines (for example by combining re-export
  statements), with every export still named.

### Native `ask_human` (nax-agent)

`askHumanToolDefinition.inputSchema` gains an optional `questions` array property describing
the shape above. Its description says each question takes 2 to 8 options, that `multiSelect`
allows several answers, and that the person can always type their own answer. The `text`
property stays required: it is the context line above the questions.
`NATIVE_CHOICE_MAX_OPTIONS = 8` is exported from `ask-human.ts` (not from the `.` entry).

In `packages/nax-agent/src/native/session/turn-tool-batch.ts` the `ask_human` branch reads
`call.input.questions`. When it is present, it runs
`parseChoiceQuestions(input.questions, { maxOptions: NATIVE_CHOICE_MAX_OPTIONS, allowOther: true })`.
A failed parse answers the call with an error tool result whose content starts
`Invalid questions: ` followed by the reason. It spends no interaction budget and makes no
interaction call. A successful parse passes the questions to `handleAskHumanCall`, which sends
`{ kind: "question", text: renderChoiceQuestionsText(question, questions), prompt: question, questions }`.
The tool result content is the answer text, which for a choice answer is the
`formatChoiceAnswers` output.

### ACP elicitation (nax-agent-acp)

In `packages/nax-agent-acp/src/client/elicitation.ts`, `askFields` takes a choice path when
all of these hold: the context's ask port has `askChoices`; after companion folding every
field is `single` or `multi`; and there are 1 to `CHOICE_MAX_QUESTIONS` fields. The path maps
each field to a `ChoiceQuestion`:

- `header`: the field title or key, through `shown()`, cut to `CHOICE_HEADER_MAX_CHARS`.
- `question`: title and description joined as `questionText` joins them today, through
  `shown()`.
- options: the field's choices, with label and description through `shown()`.
- `multiSelect` for `multi`, and `required` from the field.
- `allowOther` when the field has a companion, except a required single-select, which gets
  `false`. This matches `ownAnswerHint`, which offers no own answer there today.

It makes one call, `askChoices(shown(message), questions, { signal: ctx.signal })`, wrapped in
`.catch(() => null)` as `ask()` wraps `askQuestion`, and skipped with a cancel when
`ctx.signal.aborted`, as `ask()` does. Any other form keeps the existing one-field-at-a-time path
unchanged.

Mapping the result to elicitation content:
- `answers` present:
  - a single field takes `{ [key]: choice.value }` for its selected index;
  - a multi field takes `{ [key]: [values in index order] }`;
  - `other` takes `{ [companion]: other }`;
  - an empty entry for a non-required field sets no key.
- A required multi-select answered with only `other` declines with `REQUIRED_NOTE` noted. This
  matches today's rule that a companion only adds to a choice.
- `answers` absent (a plain text reply) and exactly one field: the reply goes through the
  existing `applyReply(field, text)`. With more than one field it declines with
  `NO_MATCH_NOTE` noted.
- `null` cancels, as today.

### Chat (nax)

- New pure model `packages/nax/src/tui/chat/choice-question.ts`:
  - `ChoiceKey`, a normalised key:
    `{ kind: "up" | "down" | "left" | "right" | "return" | "escape" | "space" | "backspace" } | { kind: "char"; char: string }`.
  - `initialChoiceState(questions)`.
  - `reduceChoiceKey(state, questions, key) -> { state, outcome?: { kind: "submit"; answers: readonly ChoiceAnswer[] } | { kind: "decline" } }`.

  The state is
  `{ tab, cursor, selected: number[][], other: (string | undefined)[], editing: boolean, draft: string, review: boolean }`.
  It is immutable: every key returns a new state. The reducer is split into one helper per key
  class so `check:complexity` stays green.
- `askCardModel` (`packages/nax/src/tui/chat/ask-card.ts`). Target: a `question` ask that
  carries `questions` becomes a new model kind
  `AskCardChoiceQuestion { kind: "choice-question"; title; prompt; border; questions }`, with
  every string passed through `sanitizeText`. A `question` ask without `questions` keeps
  `AskCardQuestion`.
- New component `packages/nax/src/tui/chat/ChoiceQuestionCard.tsx` draws the model, holds the
  `ChoiceState` locally (as `AskCard` holds its selection today) and maps ink's
  `(input, key)` to `ChoiceKey`. `choiceQuestionLayout(model, state, { width, budget, theme, expiresAt, nowMs })`
  is the single place its rows are decided. `AskCard.tsx` is already 659 lines, so the new
  card's rows, keys and rendering live in the new files, and `AskCard`, `askCardLayout` and
  `measureAskCard` only delegate the `choice-question` kind.
- Measurement is state-independent, because `measureFrameSurfaces`
  (`packages/nax/src/tui/chat/frame-surfaces.ts`) measures without the card's state.
  `measureAskCard` for a `choice-question` returns:
  - `desired`: the largest row count `choiceQuestionLayout` draws with an unlimited budget,
    over every tab and the review step;
  - `minimum`: the rows of the frame rules, the title, the tab strip (when shown), one
    question line, one option row, both `(n more ...)` rows, the hint row and the countdown
    row.

  `choiceQuestionLayout` never draws more rows than its budget. At a budget below `desired`,
  the prompt and the question are each cut to one row ending in `...` before any option row
  is withheld.
- Result mapping: `askCardLayout` returns the choice card's `head` rows (rules, title, tab
  strip, prompt, question, option window, `Other...`), its `tail` rows (hint, countdown,
  bottom rule), no `input` (`inputMaxRows` 0), `rows` as the numeric total it draws, and
  `elided` as the count of option rows the window withholds. `measureAskCard` returns `elided` 0 and `marker` 0 at `desired`, because
  the window's `(n more ...)` rows stand in for an elision marker.
- `ChatAskController` (`packages/nax/src/chat/ask-controller.ts`) gains
  `answerChoices(requestId: string, answers: readonly ChoiceAnswer[], text: string): void`,
  which calls `options.answer(requestId, { text, answers })` for an open session `question`
  and removes it. The `text` argument is `formatChoiceAnswers` over the event's original
  (unsanitised) `questions`, so the agent reads its own labels back. The card catches an
  `AGENT_SESSION_INVALID_ANSWER` throw, logs it at warn, and keeps the card open. On a
  `decline` outcome the card calls its `onDismiss` prop, which is the
  path the text card's escape takes today (`ChatApp`'s `dismissQuestion`: two-press escape
  confirm, `declineQuestion`, turn cancel).

Key map of the choice card (the cursor rows are the options plus, when `allowOther`, a last
`Other...` row):

| Key | Single-select question | Multi-select question |
|:---|:---|:---|
| up / down | move cursor, clamped at the ends | same |
| digit `1`-`9` naming an option | select that option and advance | toggle that option |
| digit beyond the option count | ignored | ignored |
| space | select the cursor option (no advance) | toggle the cursor option |
| enter on an option | select it and advance | advance |
| enter or space on `Other...` | start editing (inline text box) | same |
| left / right | previous / next tab (only with 2+ questions) | same |
| esc | decline the ask | same |

- "Advance" means the next tab. From the last question with 2+ questions it opens the review
  step. With one question it submits, provided the question is answered or not required.
- Selecting a single-select option clears that question's `other`.
- While editing, digit and space keys are typed characters. Typing edits `draft`. Enter with
  a non-empty trimmed draft stores it as that question's `other`, clears a single-select's
  selected option, and advances. Esc leaves editing without changing `other`.
- On a required question with nothing selected and no `other`, the advancing keys stay on
  the question.
- Starting to edit a question that already has an `other` seeds `draft` with it. Changing tab
  puts the cursor on the first selected option of the new tab, else on row 0.
- The review step lists each question's header with its `formatChoiceAnswers` line. Enter
  submits when every required question is answered; otherwise it moves to the first
  unanswered required tab. Left goes back to the last tab.
- Shift-tab and tab are not bound by the card: shift-tab stays `cycleMode` in `useChatKeys`.
- Drawing:
  - the tab strip `[Header] [Header] [Submit]`, shown only with 2+ questions (the active tab
    is bold, answered tabs use the success colour);
  - the prompt (when non-empty) and the question line;
  - one row per option: `> ` on the cursor row, `[x] ` / `[ ] ` for multi or `(*) ` / `( ) `
    for single, then `n. label`, then the description in the muted colour, cut to the width;
  - the `Other...` row, which shows the stored other text when set;
  - a hint row naming the keys for the current question kind;
  - the existing countdown row.
- Long lists: when the option rows do not fit the budget, the card draws a window of option
  rows that keeps the cursor visible, plus `(n more above)` / `(n more below)` rows. Those rows
  count against the budget. The question line, the hint row and the countdown are never
  withheld.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Native `ask_human` `questions` fails `parseChoiceQuestions` | error tool result `Invalid questions: <reason>`; no budget spent; no interaction call |
| `answer()` with `answers` that fail `validateChoiceAnswers` | throws `AGENT_SESSION_INVALID_ANSWER`; the request stays pending |
| Embedder answers a choice ask with a plain `{ text }` | resolves to `{ text }` with no `answers`; native passes the text to the model; ACP maps it as above |
| Choice ask times out, is cancelled, or the turn ends | `askChoices` resolves `null`; native answers "No human operator is available..." as today; ACP cancels |
| `askChoices` rejects inside the ACP path | treated as `null`: the form cancels |
| Ask port without `askChoices` | native: `askQuestion` with the rendered text; ACP: existing per-field text path |

## Out of Scope

- Run asks (`packages/nax/src/chat/jobs/run-asks.ts`) and the host-choice card (`AskCardChoice`) keep their current cards; they are not moved onto the choice card.
- The nax-agent ACP server (`packages/nax-agent-acp/src/server/questions.ts`) forwards a choice ask to its ACP client as today's text question built from the event's rendered `text`; mapping `questions` to an ACP elicitation form for that client is not part of this feature.
- The nax run-time ACP ask port (`packages/nax/src/agents/acp/ask-port.ts`), `run-interaction-handler.ts` and the Telegram/webhook interaction plugins do not implement `askChoices`; they keep the text path, which carries the rendered options.
- Elicitation forms that mix text fields with select fields, or carry more than four select fields, keep the existing one-field-at-a-time text path.
- No new config key: the choice card is always on in chat, and `ask_human`'s budget (`ASK_HUMAN_BUDGET`) is unchanged.
- Mouse clicks on choice options are not handled.
- koda does not render choice questions in this feature; koda's existing `{ text }` reply to a `question` event keeps working.

## Stories

### US-001: Choice question contract and session ask port

Workdir: `packages/nax-agent`. No dependencies.

Add `choice-questions.ts` (types, `parseChoiceQuestions`, `validateChoiceAnswers`,
`formatChoiceAnswers`, `renderChoiceQuestionsText`, the two constants). Extend the `question`
event (`questions`, `prompt`), `AnswerReply`, `PendingAskTable.issue` (validator) and
`SessionAskPort` (optional `askChoices`), and implement `askChoices` in `createSessionAskPort`.
Export the new types, constants and functions from `src/index.ts`, keeping that file at or
under 600 lines, and update `api/nax-agent.api.txt` with `bun run api:update`.

### US-002: Native ask_human offers choice questions

Workdir: `packages/nax-agent`. Depends on US-001.

Extend `askHumanToolDefinition` with the `questions` property and add
`NATIVE_CHOICE_MAX_OPTIONS`. Make the `ask_human` branch of `turn-tool-batch.ts` parse and pass
questions. Extend the `InteractionHandler` question request, `handleAskHumanCall` (rendered
`text`, `prompt`, `questions`) and `answerQuestion` in `session-interaction.ts`. Tests follow
`test/unit/native/session/turn-loop-seam.test.ts` (scripted `ask_human`) and
`test/unit/native/session-adapter-abort-reasons.test.ts` (`createSessionInteractionHandler`
with a fake `asks`).

### US-003: ACP select-only elicitation forms become one choice ask

Workdir: `packages/nax-agent-acp`. Depends on US-001.

Add the choice path to `askFields` in `elicitation.ts`, with `shown()` on every
agent-supplied string and the result-to-content mapping above.

### US-004: Choice card state model

Workdir: `packages/nax`. Depends on US-001.

Add `choice-question.ts` (`ChoiceKey`, `initialChoiceState`, `reduceChoiceKey`) implementing
the key map, editing, advance and review rules. It is a pure module: no change to
`ask-card.ts` or `AskCard.tsx` in this story.

### US-005: Choice card model kind, drawing and chat wiring

Workdir: `packages/nax`. Depends on US-004.

Add the `choice-question` kind to `askCardModel`. Add `ChoiceQuestionCard.tsx` with
`choiceQuestionLayout`. Make `AskCard`, `askCardLayout` and `measureAskCard` delegate the kind
to it. Add `ChatAskController.answerChoices` and submit through it, and decline through
`onDismiss`. Ink tests follow `test/ui/chat/chat-asks-keys.test.tsx` and
`test/ui/chat/choice-card.test.tsx`.

### Context Files

**US-001**
- `packages/nax-agent/src/session/session-ask-port.ts` — where `askQuestion` issues and emits a question
- `packages/nax-agent/src/session/pending-asks.ts` — `issue` / `answer` / `replyKind`
- `packages/nax-agent/src/session/agent-session-types.ts` — `SessionEvent` and `AnswerReply`
- `packages/nax-agent/src/session/session-backend.ts` — `SessionAskPort`
- `packages/nax-agent/src/index.ts` — the `.` export list, at the 600-line cap

**US-002**
- `packages/nax-agent/src/native/session/ask-human.ts` — the tool definition
- `packages/nax-agent/src/native/session/turn-tool-batch.ts` — the `ask_human` branch
- `packages/nax-agent/src/session/session-interaction.ts` — `answerQuestion`
- `packages/nax-agent/src/native/session/turn-ask-human.ts` — `handleAskHumanCall`
- `packages/nax-agent/test/unit/native/session/turn-loop-seam.test.ts` — scripted `ask_human` harness
- `packages/nax-agent/test/unit/native/session-adapter-abort-reasons.test.ts` — `createSessionInteractionHandler` with a fake `asks`

**US-003**
- `packages/nax-agent-acp/src/client/elicitation.ts` — `askFields`, `Field`, `applyReply`, `questionText`, `shown`
- `packages/nax-agent-acp/test/unit/client/elicitation.test.ts` — existing form tests and their fakes

**US-004**
- `packages/nax/src/tui/chat/ask-card.ts` — the model kinds the new state sits beside
- `packages/nax/src/tui/chat/AskCard.tsx` — how the approval card normalises keys today

**US-005**
- `packages/nax/src/tui/chat/AskCard.tsx` — layout, measurement and the question card it delegates from
- `packages/nax/src/tui/chat/frame-surfaces.ts` — where `measureAskCard` sizes the card without state
- `packages/nax/src/chat/ask-controller.ts` — `answerQuestion` / `declineQuestion`
- `packages/nax/src/tui/chat/choice-question.ts` — created by US-004, drawn here
- `packages/nax/test/ui/chat/chat-asks-keys.test.tsx` — ink key-driving pattern for ask cards

### Creates

**US-001**
- `packages/nax-agent/src/session/choice-questions.ts`
- `packages/nax-agent/test/unit/session/choice-questions.test.ts`

**US-002**
- `packages/nax-agent/test/unit/native/session/ask-human-choices.test.ts`

**US-003**
- `packages/nax-agent-acp/test/unit/client/elicitation-choices.test.ts`

**US-004**
- `packages/nax/src/tui/chat/choice-question.ts`
- `packages/nax/test/unit/tui/chat/choice-question.test.ts`

**US-005**
- `packages/nax/src/tui/chat/ChoiceQuestionCard.tsx`
- `packages/nax/test/unit/tui/chat/choice-question-layout.test.ts`
- `packages/nax/test/ui/chat/choice-question-card.test.tsx`

### Modifies

**US-001**
- `packages/nax-agent/src/index.ts` — gains the choice-question exports; it is at the 600-line cap, so the story may restructure its re-export statements to stay at or under 600 lines while every export stays named and no existing export is removed.
- `packages/nax-agent/api/nax-agent.api.txt` — the `.` API snapshot gains the new choice-question export names; regenerate it with `bun run api:update`, never hand-edit it.

**US-002**
None. `NATIVE_CHOICE_MAX_OPTIONS` stays off the `.` entry, the request type change is additive, and the scripted `ask_human` tests send no `questions`, so their assertions stay valid.

**US-003**
None. The choice path is a new branch taken only when the port has `askChoices`, and the existing elicitation tests use fakes without it, so their assertions stay valid.

**US-004**
None. The story only adds a new module and its test.

**US-005**
- `packages/nax/test/ui/chat/ask-card.test.tsx` — its controller fake is typed `ChatAskController`, which gains the required `answerChoices`; add a stub method, keeping every existing assertion.
- `packages/nax/test/ui/chat/chat-app.test.tsx` — its `asks` literal is typed `ChatHost['asks']`, which gains the required `answerChoices`; add `answerChoices: () => {}`, keeping every existing assertion.
- `packages/nax/test/ui/chat/chat-app-mentions.test.tsx` — its `asks` literal is typed `ChatHost['asks']`, which gains the required `answerChoices`; add `answerChoices: () => {}`, keeping every existing assertion.
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — its `asks` literal is typed `ChatHost['asks']`, which gains the required `answerChoices`; add `answerChoices: () => {}`, keeping every existing assertion.
- `packages/nax/test/unit/chat/ask-controller.test.ts` — gains the `answerChoices` cases; existing assertions stay.

### Seams

- US-002 consumes US-001's `askChoices` through `answerQuestion`. Its seam AC drives a scripted
  native turn whose model calls `ask_human` with `questions`, through
  `createSessionInteractionHandler` with a fake `asks`, and asserts `askChoices` received them.
- US-003 consumes US-001's `askChoices` through the `elicitation/create` handler. Its seam AC
  sends a select-only form to the ACP client handler and asserts one `askChoices` call.
- US-005 consumes US-004's `reduceChoiceKey` and US-001's `formatChoiceAnswers` through
  `ChatAskController.answerChoices`. Its seam AC renders `AskCard` for a pending question,
  sends the keys, and asserts the session `answer` callback got `{ text, answers }`.

## Acceptance Criteria

### US-001

- [unit] `parseChoiceQuestions([{ question: "Runner?", header: "Runner", options: [{ label: "bun" }, { label: "vitest" }] }], { maxOptions: 8, allowOther: true })` returns `ok: true` with one question whose `multiSelect` is `false`, `allowOther` is `true` and `required` is `true`.
- [unit] `parseChoiceQuestions` returns `ok: false` for an empty array, and for an array of five questions.
- [unit] `parseChoiceQuestions` returns `ok: false` with a reason naming `questions[0].options` when a question has one option, or more options than `limits.maxOptions`.
- [unit] `parseChoiceQuestions` returns `ok: false` when two options of one question have labels that differ only in case.
- [unit] `parseChoiceQuestions` cuts a 30-character header to `CHOICE_HEADER_MAX_CHARS` characters, and turns a missing header on the second question into `Q2`.
- [unit] `validateChoiceAnswers` returns `undefined` for one entry per question with in-range ascending unique indexes and at most one index on a single-select question.
- [unit] `validateChoiceAnswers` returns a reason string when the entry count differs from the question count.
- [unit] `validateChoiceAnswers` returns a reason string for a single-select entry with two selected indexes, for a single-select entry with both a selected index and `other`, and for an out-of-range index.
- [unit] `validateChoiceAnswers` returns a reason string for a required question's entry with no selected index and no `other`, and for a whitespace-only `other`. It returns `undefined` for `{ selected: [] }` on a non-required question.
- [unit] `validateChoiceAnswers` returns a reason string for an `other` on a question whose `allowOther` is `false`.
- [unit] `formatChoiceAnswers` for question `Which checks?` with options `lint`, `typecheck`, `tests`, selected `[0, 2]` and other `e2e smoke` returns `Which checks? -> lint, tests, Other: "e2e smoke"`.
- [unit] `formatChoiceAnswers` joins two questions' lines with a newline in question order, and writes `(skipped)` for an empty non-required entry.
- [unit] `renderChoiceQuestionsText("Pick:", questions)` for two questions returns text whose lines include `Pick:`, `(1/2) <first question>`, `1. <label> - <description>` for an option with a description, and the single-select instruction `Reply with one number or label.`.
- [unit] While a turn runs, `askChoices("Pick", questions)` on `createSessionAskPort` emits one `question` event whose `questions` equals the input, whose `prompt` is `Pick`, and whose `text` equals `renderChoiceQuestionsText("Pick", questions)`.
- [unit] Answering that request with `{ text: "x", answers: [{ selected: [1] }] }` resolves `askChoices` to `{ text: formatChoiceAnswers(questions, answers), answers }`.
- [unit] Answering that request with `{ text: "vitest" }` (no `answers`) resolves `askChoices` to `{ text: "vitest" }` with no `answers` field.
- [unit] Answering that request with `answers` that fail `validateChoiceAnswers` throws `AgentSessionError` code `AGENT_SESSION_INVALID_ANSWER`. A later valid answer to the same request id returns `accepted`.
- [unit] `askChoices` resolves `null` when no turn is running, and when the request's deadline passes.
- [unit] A pending-ask table entry issued without a validator accepts any `{ text }` reply to a question, as before. A validator is not run for an answer to an entry that has already expired, which returns `expired`.
- [unit] Importing `parseChoiceQuestions`, `validateChoiceAnswers`, `formatChoiceAnswers`, `renderChoiceQuestionsText`, `CHOICE_MAX_QUESTIONS` and `CHOICE_HEADER_MAX_CHARS` from the package entry `@nathapp/nax-agent` gives usable values (`CHOICE_MAX_QUESTIONS === 4`). A value typed with the `ChoiceQuestion`, `ChoiceAnswer` and `ChoiceAskResult` types imported from the same entry type-checks.

### US-002

- [unit] `askHumanToolDefinition.inputSchema.properties` has a `questions` property of type `array`, and `required` is still exactly `["text"]`.
- [unit] `handleAskHumanCall` with `questions` calls the interaction handler once with `{ kind: "question", text: renderChoiceQuestionsText(question, questions), prompt: question, questions }`, and returns a tool result whose content is the handler's answer.
- [unit] `handleAskHumanCall` without `questions` calls the interaction handler with `{ kind: "question", text }` and no `questions` or `prompt` key, as before.
- [unit] A scripted native turn (the `turn-loop-seam.test.ts` harness) is wired to `createSessionInteractionHandler` with a fake `asks` that has `askChoices`. Its model calls `ask_human` with `{ text: "Pick", questions: [one question with 3 options] }`. `askChoices` is called with `"Pick"` and one parsed `ChoiceQuestion`, and the tool result the model receives next is the text `askChoices` resolved to.
- [unit] In the same harness, a model call of `ask_human` with a `questions` entry holding one option gets an error tool result whose content starts with `Invalid questions: `. `askChoices` is not called, and a second valid `ask_human` call in the same turn is still answered (the budget was not spent).
- [unit] `createSessionInteractionHandler` with a fake `asks` that has no `askChoices` answers a question request carrying `questions` by calling `askQuestion` with the request's `text`, which is the rendered options text.
- [unit] In the scripted harness, a fake `askChoices` that resolves `null` makes the tool result `No human operator is available for this run. Proceed on your best judgement.`.
- [unit] `NATIVE_CHOICE_MAX_OPTIONS` imported from `ask-human.ts` equals 8, and a `questions` entry with 9 options is rejected with `Invalid questions: `.

### US-003

- [integration] An `elicitation/create` form with one non-required single-select field `runner` (enum `bun`, `vitest`) and a `runner_custom` string companion, handled with an ask port that has `askChoices`, makes exactly one `askChoices` call. Its one question has two options, `allowOther: true` and `required: false`, and no `askQuestion` call happens.
- [integration] For that form, an `askChoices` result with `answers: [{ selected: [1] }]` accepts with content `{ runner: "vitest" }`.
- [integration] For that form, an `askChoices` result with `answers: [{ selected: [], other: "deno" }]` accepts with content `{ runner_custom: "deno" }`.
- [integration] For that form, an `askChoices` result with `answers: [{ selected: [] }]` accepts with empty content.
- [integration] A required single-select field with a companion is asked with `allowOther: false` and `required: true`.
- [integration] A required multi-select field with a companion, answered with only `other`, declines and notes `REQUIRED_NOTE` through `noteQuestion`.
- [integration] A form with a multi-select field `checks` (items enum `lint`, `typecheck`, `tests`) answered `selected: [0, 2]` accepts with content `{ checks: ["lint", "tests"] }`.
- [integration] A form with two select fields makes one `askChoices` call with two questions in field order, and an answer for both accepts with both keys set.
- [integration] A form whose message, field title and choice label contain an ESC control byte reaches `askChoices` with those bytes stripped, and a 40-character field title becomes a header of `CHOICE_HEADER_MAX_CHARS` characters.
- [integration] For a one-field form, an `askChoices` result with no `answers` and text `2` accepts with the second choice's value, through the existing reply matching.
- [integration] For a two-field form, an `askChoices` result with no `answers` declines and notes `NO_MATCH_NOTE`.
- [integration] An `askChoices` result of `null`, and an `askChoices` that rejects, both cancel the form.
- [integration] The choice path passes the context's `signal` to `askChoices` as `opts.signal`, and a context whose signal is already aborted cancels the form without calling `askChoices`.
- [integration] A form that mixes a plain string field with a select field asks one field at a time through `askQuestion`, and `askChoices` is not called.
- [integration] A form with five select fields asks through `askQuestion` one field at a time, and `askChoices` is not called.
- [integration] A select-only form handled with an ask port that has no `askChoices` asks through `askQuestion` as before.

### US-004

- [unit] `initialChoiceState(questions)` has `tab` 0, `cursor` 0, an empty selection per question, `editing` false and `review` false.
- [unit] `reduceChoiceKey` on a single-select question with keys `down` then `return` selects option index 1. With one question, it returns outcome `{ kind: "submit", answers: [{ selected: [1] }] }`.
- [unit] `reduceChoiceKey` on a single-select question with `{ kind: "char", char: "3" }` selects index 2 and advances. A digit beyond the option count leaves the state equal to the input.
- [unit] `reduceChoiceKey` clamps the cursor: `up` at row 0 stays 0, and `down` at the last row (the `Other...` row when `allowOther`) stays there.
- [unit] `reduceChoiceKey` on a multi-select question: `space` on row 0 and char `3` give selection `[0, 2]`; a second `space` on row 0 gives `[2]`; no outcome is returned.
- [unit] `reduceChoiceKey` on a required question with nothing selected and no `other`: `return` stays on the same tab with no outcome.
- [unit] `reduceChoiceKey` on a non-required multi-select question with nothing selected: `return` advances (with one question it submits `{ selected: [] }`).
- [unit] `reduceChoiceKey` `return` on the `Other...` row sets `editing` true. Char keys (including a digit and `space`) build `draft`, `backspace` removes the last character, and `return` with draft `deno` stores `other` `deno` and advances. For single-select it clears that question's selected index.
- [unit] `reduceChoiceKey` on a single-select question whose `other` is set: selecting an option clears `other`.
- [unit] `reduceChoiceKey` while editing: `return` with a whitespace-only draft stays editing, and `escape` leaves editing with `other` unchanged and no decline outcome.
- [unit] `reduceChoiceKey` with `escape` when not editing returns outcome `{ kind: "decline" }`.
- [unit] `reduceChoiceKey` with two questions: `right` moves to tab 1, `left` moves back to tab 0, and `right` on the last tab stays there.
- [unit] `reduceChoiceKey` with two questions: answering the last question opens the review step (`review` true) with no outcome.
- [unit] In the review step, `return` with every required question answered returns outcome `submit` with one answer per question in question order.
- [unit] In the review step, `return` with required question 0 unanswered leaves review and sets `tab` 0.
- [unit] In the review step, `left` leaves review and sets `tab` to the last question.
- [unit] `reduceChoiceKey` `space` on the `Other...` row of a multi-select question sets `editing` true and leaves `selected` unchanged, so no state ever holds a selected index greater than or equal to the question's option count.
- [unit] Every `reduceChoiceKey` call returns a new state object and leaves the input state unchanged.
- [unit] With one question, `reduceChoiceKey` never sets `review` true: the advancing key submits directly.

### US-005

- [unit] `askCardModel` for a `question` ask carrying `questions` returns `kind: "choice-question"` with the questions' strings sanitised (an ESC byte in an option label is removed).
- [unit] `askCardModel` for a `question` ask without `questions` returns `kind: "question"` as before.
- [unit] `choiceQuestionLayout` for a two-question model draws a tab strip row naming both headers and `Submit`. For a one-question model it draws no tab strip.
- [unit] `choiceQuestionLayout` draws the cursor option row with `> `, multi-select rows with `[x] ` / `[ ] `, and single-select rows with `(*) ` / `( ) `, followed by `n. label`.
- [unit] `choiceQuestionLayout` draws an option's description after its label in the muted colour, cut so the row fits `width`.
- [unit] `choiceQuestionLayout` draws a last `Other...` row when `allowOther` is true, which shows the stored other text when one is set, and no such row when `allowOther` is false.
- [unit] `choiceQuestionLayout` with 12 options and a budget 6 rows short of the unlimited draw draws a window that contains the cursor row plus a `(n more below)` row at cursor 0, and a `(n more above)` row when the cursor is on the last option. The total row count never exceeds the budget.
- [unit] `choiceQuestionLayout` at a budget equal to `measureAskCard(...).minimum` still draws the question line, one option row, the hint row and the countdown row. With a 300-character question at width 40, the question is drawn as one row ending in `...` and the row count does not exceed the budget.
- [unit] `choiceQuestionLayout` draws a review step listing each question's header with its `formatChoiceAnswers` line when the state's `review` is true.
- [unit] `measureAskCard` for a two-question `choice-question` model returns a `desired` equal to the largest row count `choiceQuestionLayout` draws with an unlimited budget over both tabs and the review step.
- [unit] `ChatAskController.answerChoices(requestId, answers, text)` on an open session `question` calls the `answer` option with `{ text, answers }` and removes the ask from `pending()`.
- [unit] `ChatAskController.answerChoices` on an unknown request id, or on a host question (`host-question-` id), does not call `answer`.
- [integration] Rendering `AskCard` for a pending session `question` with one single-select question and sending down then return calls the controller's `answer` callback once with `answers: [{ selected: [1] }]` and `text` equal to `formatChoiceAnswers(questions, answers)`.
- [integration] Rendering `AskCard` for a pending session `question` with one multi-select question and sending space, down, space, return answers with `answers: [{ selected: [0, 1] }]`.
- [integration] Rendering `AskCard` for a pending session choice question whose `answer` callback throws `AGENT_SESSION_INVALID_ANSWER` keeps the choice card drawn after the submitting key, and the render does not throw.
- [integration] Rendering `AskCard` for a pending session choice question and sending escape calls the `onDismiss` prop once, and the `answer` callback is not called.
- [integration] Rendering `AskCard` for a pending session `question` without `questions` still draws the text-box question card and submits typed text through `answerQuestion`.
