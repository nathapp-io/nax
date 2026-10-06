# S4-5: ACP events, usage and elicitation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `acpBackend()` reports a turn the way the native backend does: thinking, tool calls with their results, and one `usage` event with the turn's tokens and reported cost (spec §6.7). A form elicitation from the agent becomes `question` events the caller answers with `answer()` under `ask` and `full` (spec §6.8, amended).

**Architecture:**
- Four new modules under `packages/nax-agent-acp/src/client/`:

  | Module | Role |
  |---|---|
  | `stream-scrub.ts` | scrubs the session's secret values from a stream of text chunks, holding back only the tail that could start a secret (D5-g) |
  | `usage.ts` | per-turn tokens from `PromptResponse.usage` (D5-a), the session's cost meter over cumulative `usage_update.cost` (D5-b), the `usage` event (D5-h) |
  | `tool-events.ts` | merges `tool_call` / `tool_call_update` per call; emits `tool_call` when the call is used and exactly one `tool_result` per announced call (D5-c to D5-f) |
  | `elicitation.ts` | `elicitation/create` → one `question` per form field; the reply maps back to the form's content (D5-i) |

- `events.ts` becomes the turn's collector over those modules: `onUpdate`, `announce`, `finish`, `settle(response)`, `output`.
- `turn.ts` settles the collector with the `PromptResponse`, so the turn's `TurnResult` carries real tokens and cost, and a non-`end_turn` stop still emits its `usage` event.
- `inbound.ts` routes `elicitation/create` like a permission request (bound session, running turn, the 16-request cap) and announces a permission request's tool call.
- `connection.ts` registers the `elicitation/create` handler. `open.ts` advertises `elicitation.form` under `ask` and `full`.
- `backend.ts` keeps one cost meter per session, wires the elicitation handler and finishes the collector after the turn's binding is released.
- nax-agent gains one optional argument: `SessionAskPort.askQuestion(text, { signal })` (D5-j), so a question settles at once when its turn's binding is released or the agent process dies.
- The fake ACP agent gains an `update` step (any `session/update`) and an `elicit` step, and its `text` step can echo the tool host's `Authorization` value.

**Tech Stack:**
- `@agentclientprotocol/sdk` 1.7.0: `SessionUpdate`, `PromptResponse`, `CreateElicitationRequest`, `CreateElicitationResponse`, `ElicitationContentValue`, `ElicitationSchema`, `ClientCapabilities`, `methods.client.elicitation.create`
- `@nathapp/nax-agent` public `.`: `TurnEvent`, `TurnEventSink`, `TurnResult`, `TokenUsage`, `SessionAskPort`, `AgentSessionProfile`, `redactSecrets`, `capStrings`, `TOOL_CALL_INPUT_BYTES`, `TOOL_RESULT_PREVIEW_BYTES`, `getLogger`
- bun:test (unit), vitest on Node 22/24 (contract)

**Spec:** `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`. Sections used:
- §6.7 Event mapping and usage (the whole section; amended by D5-a to D5-h)
- §6.8 Elicitation → `question` (the whole section; amended by D5-i)
- §2.2 R9 (amended by D5-i)
- §5.1 `SessionAskPort` (`askQuestion` gains `{ signal }`, D5-j)
- §6.3 step 1.1 ("`elicitation.form` under `ask`/`full`"), step 5 ("pending asks and questions settle as `cancelled` at once"), "Inbound requests with no active turn" (elicitation → `cancel`)
- §6.6 "Token secrecy" (agent-authored text, open since S4-4 D4-m)
- §10 S4-0 Done-when (a nax-agent `session/` change requires the billed `nax run` S1-recipe smoke) and the S4-5 row
- §12 risk "Cumulative usage semantics differ per adapter"

## Global Constraints

- nax-agent-acp imports nax-agent only as `@nathapp/nax-agent` (public `.`), never `./internal` or a deep path, in `src/` or `test/` (§4).
- `src/` imports only `@agentclientprotocol/sdk` (root, never `/experimental` or `/v2`), `@modelcontextprotocol/sdk`, `zod` and `node:` builtins. No Bun API in `src/` (`check:no-bun-apis`).
- `src/` imports its own modules as `#src/client/<module>`.
- No `throw new Error(` in `src/` (`check-nax-error`, baseline 0).
- `round` is always 0. `stream_reset` and `compaction` are never emitted by the ACP backend. `turn_end.output` is the turn's concatenated agent message text (§6.7).
- `tool_call.input` and `tool_result.preview` are capped as nax-agent caps them: input JSON at `TOOL_CALL_INPUT_BYTES` (8192) else `{ truncated: true, preview }`; preview at `TOOL_RESULT_PREVIEW_BYTES` (4096); redaction scans at most 16 × 4096 bytes (§5.6, native `turn-event-emitter.ts`).
- Usage: output tokens = `outputTokens + thoughtTokens`; cache read and write map to `cacheRead` / `cacheWrite` and stay absent when not reported (never coerced to 0); with no cost reported `costUsd: 0`, `costSource: "unpriced"`; a reported cost is `costSource: "reported"` (§5.5, §6.7).
- Elicitation is advertised (`clientCapabilities.elicitation.form`) under `ask` and `full` only. Responses use only the actions `accept`, `decline` and `cancel` (§6.8).
- With no active turn, for another session, or request-scoped, an elicitation is answered `cancel` and raises no event (§6.3).
- Resume stays refused before spawning (S4-2 D-b) until S4-6.
- Gates (from `packages/nax-agent-acp`):
  - file sizes: 600 lines per src file, 800 per test file
  - complexity: 20 per function
  - coverage: 80% overall and per src file; the per-file baseline stays empty
  - import cycles: none
  - test satellites: each new `src/client/<m>.ts` gets `test/unit/client/<m>.test.ts`; other test files are `<module>-<concern>.test.ts`, never named after a ticket
  - no `as unknown as`, `as any` or `@ts-ignore` in tests: build malformed input with `JSON.parse`, as the S4-2 tests do
- nax-agent (Task 0 only): the change stays inside `src/session/session-backend.ts` and `src/session/session-ask-port.ts`, plus its test and CHANGELOG. The API snapshot does not change (it lists `type SessionAskPort` by name only).
- Nothing is released in S4-5: no tag, no publish (§10).
- `packages/nax/` does not change.
- Never run bare `bun test` (no path) and never `bun run nax`. Package commands run from the package directory.
- Code in this plan is not pre-formatted: run `bun run lint:fix` in the package before every `check:all`.
- No emojis in code, comments or docs. Edit `.nax/**/context.md` only, then regenerate. Never hand-edit `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` or `codex.md`.
- Where this plan changes an existing file, it gives the whole new file or an exact old/new edit. Nothing is elided: do not merge from fragments.

## Review Focus

1. **A secret split across two chunks of agent text.** The tool host's token or an `env` secret arrives as `"...s3cr3t-tok"` then `"en-value-0123..."`, in text or in thoughts. No `text_delta` or `thinking_delta` may carry any part of it that, joined with its neighbours, reads as the secret, and `turn_end.output` shows `[REDACTED]`. Held-back text must still come out, in order, before the next tool event, the other stream's next delta and the end of the turn. Pinned in Task 1 (scrubber) and Task 7 (end to end, the real tool-host token).
2. **A question left open after its turn stops.** The agent asks, then the caller cancels, the turn times out, or the agent process dies. The `question` must settle at once: `answer()` on it returns `"cancelled"`, not `"accepted"`, and the agent's elicitation is answered `cancel`. Pinned in Task 0 (the ask port's extra signal) and Task 7 (cancel and crash during a question).
3. **Claude's AskUserQuestion forms.** One choice field per question plus a `question_<n>_custom` free-text field, and several such pairs for several questions. A reply by number, by choice text in any case, a free-text answer instead of a choice, a comma list for a multi-select, an empty reply to skip, and a reply that matches nothing for a field without a companion must each produce the form content Claude's adapter reads back (or `decline`). Pinned in Task 5, and end to end in Task 7.
4. **Usage across turns.** Turn 1 reports tokens and a cumulative cost of 0.01; turn 2 reports its own tokens and a cumulative cost of 0.025. The second turn's `usage` is its own tokens and 0.015, not a difference of tokens and not 0.025. A turn with no cost update is `unpriced`, and its spend is not lost: it lands in the next priced turn. A cost counter that restarts at zero never produces a negative cost. Pinned in Task 2 and Task 7.
5. **Hostile or odd tool updates.** An update with no id, an id holding a secret, a 600th call in one turn, a repeated `completed`, a `failed` with no content, a diff of 2 MB, an input that is a huge string or a deep object, a tool title of `"tool call"`: none may throw, emit a `tool_result` without a `tool_call`, emit two results for one call, or leak a session secret into `input`, `name` or `preview`. Pinned in Task 3.

## Decisions taken in this plan (for review)

Evidence for D5-a to D5-d was read from `@agentclientprotocol/claude-agent-acp` 0.85.1 (the registry pin, unpacked from `npm pack`) and `@agentclientprotocol/sdk` 1.7.0 `dist/schema/types.gen.d.ts`.

- **D5-a. Token usage in `PromptResponse.usage` is per turn, not session-cumulative (corrects §6.7).** The spec computed a delta against the previous turn's totals. The protocol contradicts itself: `PromptResponse.usage` is documented as "Token usage for this turn (optional)" (and is UNSTABLE), while the `Usage` field comments say "Total input tokens across all turns". Claude's adapter is per turn: `acp-agent.js` 2491-2496 resets `session.accumulatedUsage` to zeros when a turn is activated, 4039-4051 adds each result's tokens to it, and `sessionUsage()` (7310-7318) returns it in the `PromptResponse`. The spec's delta would have reported turn 2's tokens minus turn 1's. Tokens are therefore taken as reported, per turn, with no baseline. §6.7 and the §12 risk are amended (Task 9).
- **D5-b. Cost is cumulative; a turn's cost is the difference.** `UsageUpdate.cost` is documented as "Cumulative session cost", and Claude's adapter sends `cost: { amount: message.total_cost_usd, currency: "USD" }` (`acp-agent.js` 4103-4113). The session keeps one cost meter. It remembers the last reading taken at the end of a priced turn (0 for a new agent process). A turn's cost is the latest USD reading seen during the turn minus that baseline. A negative difference means the agent's counter restarted, and the turn reports the raw reading. A reading that is not USD, not finite or negative is ignored. A turn with no reading is `unpriced` (`costUsd: 0`) and leaves the baseline alone, so spend between turns, or in a turn that ended without a `PromptResponse`, lands in the next priced turn. S4-6 resets the meter on reconnect and resume.
- **D5-c. A tool call's `tool_call` event goes out when the call is used.** Claude sends `tool_call` with `status: "pending"` and "the input as it stands, also the empty input at the stream start" (`tool-calls/renderer.js` 52-77), then refines the input in `tool_call_update`s. Emitting at first sight would report `{}` for most calls. The event goes out at the first of: a permission request that names the call (so `tool_call` precedes `approval_requested`), or an update with status `in_progress`, `completed` or `failed`. It carries the input known at that moment. A call that is never used emits nothing, as native emits nothing for calls the loop answers without running.
- **D5-d. A tool call's name is the agent's tool name first.** SDK 1.7.0 `ToolCall` has an optional `name`, and Claude sets it to the Claude tool name (`renderer.js` 66: `name: toolUse.name`, for example `Bash` or `mcp__nax__lookup`). That matches native's `tool_call.name` (a tool name, not a description). Order: the first non-empty `name`; else the spec's rule (the first title that is non-empty and not a placeholder `"tool call"` / `"tool"`, case-insensitive); else `kind`; else `"tool"`. Control and invisible characters are stripped, whitespace collapsed, session secrets scrubbed, capped at 200 characters. §6.7 is amended.
- **D5-e. Every `tool_call` gets exactly one `tool_result`.** `completed` or `failed` answers it (`isError: status === "failed"`). A second terminal update for the same call is ignored. When the turn finishes, each announced call left without a result is answered `isError: true` with native's text `"Not answered: the turn ended."`. At most 512 calls are tracked per turn; updates for further new ids are ignored, so they emit nothing. Ids go through the same cleaning as approval displays (`cleanCallId`, exported from `tool-display.ts`), so `tool_call.callId` equals `approval_requested.callId` for the same call, and an id that holds a secret is dropped.
- **D5-f. Preview and input are agent data, treated like native's.** Preview: the text of the latest `content` (`text` blocks, a `resource_link`'s `uri`, each `diff` as `edit <path> (+a -b)`; `terminal` entries are skipped because client terminals are never advertised, R11), else `rawOutput` when it is a string. `+a -b` counts lines by a multiset difference (linear time), and a diff over 1 MiB of text is shown as `edit <path>` without counts. Input: the latest `rawInput` (`{}` when there is none), each string cut to the scan bound, the session's secrets scrubbed from every string, `redactSecrets`, then the JSON cap. Preview: cut to the scan bound, control and invisible characters stripped, secrets scrubbed, `redactSecrets`, then cut to 4096 bytes.
- **D5-g. Agent text is scrubbed of the session's secret values (closes S4-4 D4-m's open point).** `text_delta`, `thinking_delta` and `turn_end.output` have each session secret value (the `env` secrets of 8 or more characters, and the tool-host token) replaced with `[REDACTED]`. Pattern redaction is not applied to deltas, matching nax-agent's `TurnEvent` contract ("Text and thinking deltas are not redacted"). So that a secret split across chunks is caught, each stream holds back at most the longest secret's length minus one characters, and emits them when the next chunk arrives, before the other stream's next delta, before any tool event and when the turn finishes. A session without secrets holds nothing back: chunks pass through unchanged, one event per chunk.
- **D5-h. One `usage` event per `PromptResponse`.** It is emitted after the turn's last delta and tool result, also when the stop reason is not `end_turn` (before the `ACP_STOP_*` error is thrown). A turn that ends without a `PromptResponse` (abort, crash, JSON-RPC error) emits no `usage` event. Known limit, documented: the facade reads an errored turn's spend only from nax-agent's internal `SessionTurnError`, so `turn_end.usage` of an errored ACP turn stays zero; the `usage` event carries the real numbers.
- **D5-i. Elicitation asks one question per form field (maintainer ruling 2026-10-06; amends R9 and §6.8).** Claude's AskUserQuestion always sends at least two fields: a choice field `question_<n>` (`type: "string"` with titled `oneOf`, or `type: "array"` with `items.anyOf` for a multi-select) and a free-text `question_<n>_custom` ("Other"), none required (`elicitation.js` `askUserQuestionsToCreateRequest`). R9 as written would decline every one of them. The rules:
  - Only `mode: "form"` with a `requestedSchema` object is answered; anything else (`url`, unknown modes) is noted with `noteQuestion("declined: <message>")` and declined.
  - Field kinds: a `string` with no `enum`/`oneOf` is free text; a `string` with `enum` (strings) or `oneOf` (`{ const, title? }`) is a single-select; an `array` whose `items` has `enum`, `anyOf` or `oneOf` is a multi-select. Any other type (number, integer, boolean, unknown), an empty or malformed choice list, more than 32 choices, or more than 16 fields declines the whole form, noted first.
  - A plain string field named `<key>_custom` next to a select `<key>` is that select's companion. It is not asked on its own; a reply that names no choice becomes its value.
  - No fields: the message alone is asked; a reply accepts with `content: {}`.
  - Each remaining field is one `question`, in order. Its text: the form's message (first question only), the field's title or description (prefixed `(i/n)` when there are several), the choices numbered `1.`, `2.`, ... with their descriptions, and an instruction line.
  - Replies, trimmed: empty skips an optional field and declines a required one. A single-select matches a choice by number, by value or by title, case-insensitively; no match goes to the companion if there is one, else declines. A multi-select splits on commas and matches each part; unmatched parts are joined with `", "` into the companion, or decline without one. Free text is taken as written.
  - No reply (deadline, cancel, turn end, process exit) at any question answers `cancel`, and later fields are not asked.
  - A decline after a reply is noted: `noteQuestion("declined: the reply matches no choice")` or `"declined: an answer is required"`.
  - Question text is agent data: control and invisible characters stripped, session secrets scrubbed, at most 4096 bytes.
  - Under `none` and `read`, elicitation is not advertised; one that arrives anyway is declined without a question.
- **D5-j. `SessionAskPort.askQuestion(text, { signal })` (maintainer ruling 2026-10-06).** Today a question settles only by `answer()`, its deadline or the facade's turn signal, which does not abort when a turn ends errored because the agent process died. Spec §6.3 step 5 requires pending questions to settle `cancelled` at once. The optional `signal` is combined with the turn signal, exactly as `ApprovalRequest.signal` already is for approvals. It is part of the unreleased 0.3.0 contract, like S4-2's `NaxError` and S4-3's `getLogger`. The API snapshot lists `type SessionAskPort` by name only, so it does not change. It touches nax-agent `src/session/`, so the S4-0 Done-when applies: the billed `nax run` S1-recipe smoke runs before merge, with maintainer approval at launch (Task 10). §5.1 is amended.
- **D5-k. Elicitation routing mirrors permission routing.** Only the bound agent session, during a turn, under the shared cap of 16 pending inbound requests (permissions and elicitations together). A request-scoped elicitation (`requestId` instead of `sessionId`), one for another session, one with no turn, or one over the cap is answered `cancel` with no event. Each reason is logged once per session as "Cancelled an elicitation locally". Releasing the binding aborts the handler's signal and waits for its answer, as for permissions.
- **D5-l. `clientCapabilities` by profile.** `initialize` sends `{ elicitation: { form: {} } }` under `ask` and `full` and `{}` under `none` and `read`. Verified: the SDK's agent-side parse keeps `elicitation: { form: {} }` as sent and adds its usual `fs`, `terminal` and `auth` defaults.
- **D5-m. The fake agent's new steps.** `update` sends any `session/update` for the prompt's session. `elicit` sends `elicitation/create` (form by default; `mode: "url"`; `scope: "request"` or `"other"` for routing tests) and records `elicitation-answer` with the response or `elicitation-error`; `detached: true` sends it without waiting, and `settled` waits for it. The `text` step gains `echoMcpAuth`, which appends the tool host's `Authorization` value (scrubbing tests).

---

## File structure

**Create (package `packages/nax-agent-acp/`):**

| Path | Responsibility |
|---|---|
| `src/client/stream-scrub.ts` | `createStreamScrubber(secrets): StreamScrubber` (`push`, `flush`) |
| `src/client/usage.ts` | `tokenUsageOf`, `createCostMeter` (`CostMeter`), `turnSpend`, `usageEvent`, `TurnSpend` |
| `src/client/tool-events.ts` | `createToolEvents(emit, secrets): ToolEvents`; `inputOf`, `previewOf`, `diffSummary`; `MAX_TRACKED_CALLS`, `TOOL_NAME_MAX_CHARS`, `UNANSWERED_PREVIEW`, `DIFF_COUNT_MAX_CHARS` |
| `src/client/elicitation.ts` | `answerElicitation(request, ctx)`; `QUESTION_MAX_BYTES`, `MAX_FORM_FIELDS`, `MAX_CHOICES`, `NO_MATCH_NOTE`, `REQUIRED_NOTE` |
| `test/unit/client/stream-scrub.test.ts` | the scrubber |
| `test/unit/client/usage.test.ts` | tokens, the cost meter, the event |
| `test/unit/client/tool-events.test.ts` | tool call merging, timing, results, caps and hygiene |
| `test/unit/client/elicitation.test.ts` | form parsing, questions and reply mapping |
| `test/unit/client/backend-events.test.ts` | end to end in process: events, usage, scrubbing, elicitation |

**Modify:**

| Path | Change |
|---|---|
| `packages/nax-agent/src/session/session-backend.ts` | `askQuestion(text, opts?)` (D5-j) |
| `packages/nax-agent/src/session/session-ask-port.ts` | combine `opts.signal` with the turn signal |
| `packages/nax-agent/test/unit/session/session-ask-port.test.ts` | the extra signal |
| `packages/nax-agent/CHANGELOG.md` | one Added line |
| `src/client/text.ts` | export `MIN_SECRET_LENGTH`; add `scrubDeep`, `cleanLabel` |
| `src/client/tool-display.ts` | export `cleanCallId` (was the private `callIdOf`) |
| `src/client/events.ts` | the collector (whole file) |
| `src/client/turn.ts` | settle the collector with the response (whole file) |
| `src/client/connection.ts` | `InboundHandlers.onElicitation`; register `elicitation/create` (whole file) |
| `src/client/inbound.ts` | elicitation routing, shared cap, announce (whole file) |
| `src/client/open.ts` | `clientCapabilitiesFor(profile)` |
| `src/client/backend.ts` | cost meter, elicitation handler, `finish()` after release (whole file) |
| `src/client/index.ts` | header comment |
| `test/fixtures/fake-agent/script.ts`, `agent.ts` | `update` and `elicit` steps, `text.echoMcpAuth` |
| `test/unit/client/text.test.ts`, `tool-display.test.ts`, `events.test.ts`, `inbound.test.ts`, `connection.test.ts`, `open.test.ts`, `backend-permissions.test.ts` | as each task says |
| `test/node/acp-backend.test.ts` | one usage-and-question test on Node |
| `README.md`, `CHANGELOG.md`, `.nax/mono/packages/nax-agent-acp/context.md` | S4-5 behaviour |
| `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` | R9, §5.1, §6.6, §6.7, §6.8, §11.2, §12 (D5-a to D5-j) |

---
### Task 0: nax-agent `askQuestion(text, { signal })` (D5-j)

**Files:**
- Modify: `packages/nax-agent/src/session/session-backend.ts` (the `askQuestion` line of `SessionAskPort`)
- Modify: `packages/nax-agent/src/session/session-ask-port.ts` (`askQuestion`)
- Test: `packages/nax-agent/test/unit/session/session-ask-port.test.ts`
- Modify: `packages/nax-agent/CHANGELOG.md`

**Interfaces:**
- Produces: `SessionAskPort.askQuestion(text: string, opts?: { readonly signal?: AbortSignal }): Promise<string | null>`. Task 5 calls it with the binding signal.

- [ ] **Step 1: Write the failing test**

In `packages/nax-agent/test/unit/session/session-ask-port.test.ts`, add after the test `"askQuestion resolves with the text, and null on cancel"`:

```ts
  test("an extra abort signal settles the question cancelled at once (S4-5 D5-j)", async () => {
    const { events, table, port } = setup();
    const extra = new AbortController();
    const pending = port.askQuestion("Which env?", { signal: extra.signal });
    const q = events.find((e) => e.type === "question") as { requestId: string };
    extra.abort();
    expect(await pending).toBeNull();
    expect(table.answer(q.requestId, { text: "late" })).toBe("cancelled");
  });

  test("an already-aborted extra signal settles the question at once", async () => {
    const { port } = setup();
    expect(await port.askQuestion("Which env?", { signal: AbortSignal.abort() })).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/nax-agent && bun test test/unit/session/session-ask-port.test.ts`
Expected: FAIL. TypeScript accepts the extra argument at runtime, but the question ignores the signal, so `await pending` never settles and the test times out (or `answer()` returns `"accepted"`).

- [ ] **Step 3: Implement**

In `packages/nax-agent/src/session/session-backend.ts` replace:

```ts
  /** The person's text, or null on deadline, cancel or no running turn. */
  askQuestion(text: string): Promise<string | null>;
```

with:

```ts
  /**
   * The person's text, or null on deadline, cancel or no running turn. `opts.signal`
   * is an extra abort source combined with the turn signal, as for approvals (for
   * example a backend's per-request scope that ends before the turn does).
   */
  askQuestion(text: string, opts?: { readonly signal?: AbortSignal }): Promise<string | null>;
```

In `packages/nax-agent/src/session/session-ask-port.ts` replace:

```ts
    async askQuestion(text) {
      const turn = deps.turn();
      if (turn === undefined) return null;
      const { requestId, expiresAt, settled } = deps.table.issue("question", turn.signal);
```

with:

```ts
    async askQuestion(text, opts) {
      const turn = deps.turn();
      if (turn === undefined) return null;
      const signal = opts?.signal === undefined ? turn.signal : AbortSignal.any([turn.signal, opts.signal]);
      const { requestId, expiresAt, settled } = deps.table.issue("question", signal);
```

- [ ] **Step 4: Run the tests and the nax-agent gates**

Run (from `packages/nax-agent`):
```bash
bun test test/unit/session/session-ask-port.test.ts
bun run typecheck && bun run check:api && bun run check:all
```
Expected: PASS; `check:api` reports no snapshot change.

- [ ] **Step 5: CHANGELOG**

In `packages/nax-agent/CHANGELOG.md`, under `## [Unreleased]` → `### Added`, append the line:

```md
- `SessionAskPort.askQuestion(text, { signal })`: an extra abort source combined with the turn signal, as `ApprovalRequest.signal` is for approvals, so a backend can settle a question when its own request scope ends (S4 spec §6.3 step 5).
```

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent/src/session/session-backend.ts packages/nax-agent/src/session/session-ask-port.ts packages/nax-agent/test/unit/session/session-ask-port.test.ts packages/nax-agent/CHANGELOG.md
git commit -m "feat(nax-agent): askQuestion takes an extra abort signal"
```

---

### Task 1: Text helpers and the stream scrubber (D5-g)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/text.ts`
- Modify: `packages/nax-agent-acp/src/client/tool-display.ts`
- Create: `packages/nax-agent-acp/src/client/stream-scrub.ts`
- Test: `packages/nax-agent-acp/test/unit/client/text.test.ts`, `test/unit/client/tool-display.test.ts`, `test/unit/client/stream-scrub.test.ts`

**Interfaces:**
- Produces (`text.ts`): `MIN_SECRET_LENGTH = 8`; `scrubDeep(value: unknown, secrets: readonly string[]): unknown`; `cleanLabel(value: unknown, secrets: readonly string[], maxChars: number): string | undefined`.
- Produces (`tool-display.ts`): `cleanCallId(value: unknown, secrets: readonly string[]): string | undefined`.
- Produces (`stream-scrub.ts`): `interface StreamScrubber { push(chunk: string): string; flush(): string }`; `createStreamScrubber(secrets: readonly string[]): StreamScrubber`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/nax-agent-acp/test/unit/client/text.test.ts` (and add `cleanLabel`, `MIN_SECRET_LENGTH`, `scrubDeep` to its import from `#src/client/text`):

```ts
describe("scrubDeep and cleanLabel (S4-5 D5-d, D5-f)", () => {
  const SECRET = "s3cr3t-token-value-0123";

  test("scrubDeep scrubs every string, keys included, and keeps the shape", () => {
    const input = { cmd: `curl -H ${SECRET}`, list: [SECRET, 3, null, true], [SECRET]: { deep: `x${SECRET}y` } };
    expect(scrubDeep(input, [SECRET])).toEqual({
      cmd: "curl -H [REDACTED]",
      list: ["[REDACTED]", 3, null, true],
      "[REDACTED]": { deep: "x[REDACTED]y" },
    });
    expect(scrubDeep("plain", [])).toBe("plain");
    expect(scrubDeep(42, [SECRET])).toBe(42);
  });

  test("scrubDeep keeps a __proto__ key as data", () => {
    const scrubbed = scrubDeep(JSON.parse('{"__proto__": {"polluted": true}}'), []);
    expect(Object.getPrototypeOf(scrubbed)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  test("cleanLabel: one line, visible characters, secrets scrubbed, capped by code points", () => {
    expect(cleanLabel("  Run\n\t`ls`‮  ", [], 200)).toBe("Run `ls`");
    expect(cleanLabel(`use ${SECRET}`, [SECRET], 200)).toBe("use [REDACTED]");
    expect(cleanLabel("\u{1f600}".repeat(5), [], 3)).toBe("\u{1f600}".repeat(3));
    expect(cleanLabel("   ", [], 200)).toBeUndefined();
    expect(cleanLabel(7, [], 200)).toBeUndefined();
  });

  test("MIN_SECRET_LENGTH is the scrub floor", () => {
    expect(MIN_SECRET_LENGTH).toBe(8);
    expect(scrubDeep("short1", ["short1"])).toBe("short1");
  });
});
```

Append to `packages/nax-agent-acp/test/unit/client/tool-display.test.ts` (and add `cleanCallId` to its import from `#src/client/tool-display`):

```ts
describe("cleanCallId (S4-5 D5-e)", () => {
  test("keeps an ordinary id, strips invisible characters and whitespace", () => {
    expect(cleanCallId("toolu_01", [])).toBe("toolu_01");
    expect(cleanCallId("tool u​_02", [])).toBe("toolu_02");
  });

  test("drops a missing, empty, oversized or secret-holding id", () => {
    expect(cleanCallId(undefined, [])).toBeUndefined();
    expect(cleanCallId("  ", [])).toBeUndefined();
    expect(cleanCallId("x".repeat(513), [])).toBeUndefined();
    expect(cleanCallId("id-s3cr3t-token-value-0123", ["s3cr3t-token-value-0123"])).toBeUndefined();
  });
});
```

Create `packages/nax-agent-acp/test/unit/client/stream-scrub.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createStreamScrubber } from "#src/client/stream-scrub";

const SECRET = "s3cr3t-token-value-0123";

function run(secrets: readonly string[], chunks: readonly string[]): { readonly emitted: string[]; readonly all: string } {
  const scrubber = createStreamScrubber(secrets);
  const emitted = chunks.map((chunk) => scrubber.push(chunk));
  const rest = scrubber.flush();
  return { emitted: [...emitted, rest], all: [...emitted, rest].join("") };
}

describe("createStreamScrubber (S4-5 D5-g)", () => {
  test("without secrets every chunk passes through at once and nothing is held", () => {
    const { emitted } = run([], ["a", "b", "c"]);
    expect(emitted).toEqual(["a", "b", "c", ""]);
  });

  test("a secret inside one chunk is replaced", () => {
    expect(run([SECRET], [`key ${SECRET} ok`]).all).toBe("key [REDACTED] ok");
  });

  test("a secret split across chunks is replaced, and no emitted piece holds a part that joins into it", () => {
    const { emitted, all } = run([SECRET], ["key s3cr3t-tok", "en-val", "ue-0123 ok"]);
    expect(all).toBe("key [REDACTED] ok");
    expect(emitted.some((piece) => piece.includes("s3cr3t") || piece.includes("value-0123"))).toBe(false);
  });

  test("a secret split one character per chunk is still caught", () => {
    expect(run([SECRET], [..."<<", ...SECRET, ..."!!"]).all).toBe("<<[REDACTED]!!");
  });

  test("holds back at most the longest secret's length minus one", () => {
    const scrubber = createStreamScrubber(["12345678", SECRET]);
    const out = scrubber.push("x".repeat(100));
    expect(out).toBe("x".repeat(100 - (SECRET.length - 1)));
    expect(scrubber.flush()).toBe("x".repeat(SECRET.length - 1));
  });

  test("never splits a surrogate pair at the hold-back boundary", () => {
    const scrubber = createStreamScrubber(["abcdefgh"]);
    const out = scrubber.push(`aaaa\u{1f600}${"z".repeat(6)}`);
    expect(out.endsWith("\ud83d")).toBe(false);
    expect(out + scrubber.flush()).toBe(`aaaa\u{1f600}${"z".repeat(6)}`);
  });

  test("secrets shorter than 8 characters are ignored", () => {
    expect(run(["abc"], ["abc abc"]).emitted).toEqual(["abc abc", ""]);
  });

  test("flush empties the hold; a second flush returns nothing", () => {
    const scrubber = createStreamScrubber([SECRET]);
    scrubber.push("tail");
    expect(scrubber.flush()).toBe("tail");
    expect(scrubber.flush()).toBe("");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/text.test.ts test/unit/client/tool-display.test.ts test/unit/client/stream-scrub.test.ts`
Expected: FAIL: `scrubDeep`, `cleanLabel`, `MIN_SECRET_LENGTH`, `cleanCallId` are not exported, and `#src/client/stream-scrub` does not exist.

- [ ] **Step 3: Implement `text.ts`**

In `packages/nax-agent-acp/src/client/text.ts`:

Replace the header comment's last sentence:

```ts
 * split a character. Shared by error excerpts (errors.ts) and the approval display
 * (tool-display.ts).
```

with:

```ts
 * split a character. Shared by error excerpts (errors.ts), the approval display
 * (tool-display.ts), turn events (stream-scrub.ts, tool-events.ts) and questions
 * (elicitation.ts).
```

Replace:

```ts
/** Shorter secret values are not replaced verbatim: they would garble ordinary text. */
const MIN_SECRET_LENGTH = 8;
```

with:

```ts
/** Shorter secret values are not replaced verbatim: they would garble ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** A label longer than this is cut before cleaning; the result is far shorter. */
const LABEL_SCAN_CHARS = 16 * 1024;
```

Append at the end of the file:

```ts
/**
 * `value` with every string, keys included, scrubbed of the session's secret values.
 * Expects acyclic JSON-like data (capStrings output). Keys are written as data, so a
 * `__proto__` key stays an own property.
 */
export function scrubDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [scrubSecrets(key, secrets), scrubDeep(item, secrets)]),
  );
}

/**
 * A one-line label from agent text: control and invisible characters removed,
 * whitespace collapsed, secrets scrubbed, at most `maxChars` code points. Undefined
 * for a non-string or a label that is empty after cleaning.
 */
export function cleanLabel(value: unknown, secrets: readonly string[], maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const visible = stripInvisible(stripControl(value.slice(0, LABEL_SCAN_CHARS)));
  const text = scrubSecrets(visible.replace(/\s+/g, " ").trim(), secrets);
  const capped = Array.from(text).slice(0, maxChars).join("");
  return capped === "" ? undefined : capped;
}
```

- [ ] **Step 4: Implement `cleanCallId` in `tool-display.ts`**

In `packages/nax-agent-acp/src/client/tool-display.ts` replace:

```ts
/** The agent's id without invisible characters or whitespace; dropped when it held a secret. */
function callIdOf(call: Call, secrets: readonly string[]): string | undefined {
  if (typeof call.toolCallId !== "string" || call.toolCallId.length > CALL_ID_MAX_CHARS) return undefined;
  const id = stripInvisible(stripControl(call.toolCallId)).replace(/\s+/g, "");
```

with:

```ts
/**
 * The agent's tool call id without invisible characters or whitespace; undefined
 * when it is not a string, is empty or oversized, or held a secret. Approval events
 * and tool events both use it, so their callIds match (S4-5 D5-e).
 */
export function cleanCallId(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.length > CALL_ID_MAX_CHARS) return undefined;
  const id = stripInvisible(stripControl(value)).replace(/\s+/g, "");
```

and in `describeToolCall` replace:

```ts
  const callId = callIdOf(call, secrets);
```

with:

```ts
  const callId = cleanCallId(call.toolCallId, secrets);
```

- [ ] **Step 5: Create `stream-scrub.ts`**

Create `packages/nax-agent-acp/src/client/stream-scrub.ts`:

```ts
/**
 * Agent text as a stream, scrubbed of the session's secret values (S4-5 D5-g). A
 * secret can arrive split across two chunks, so each push scrubs the held tail plus
 * the new chunk and then holds back the last (longest secret length - 1)
 * characters: any secret not yet complete must start inside them. flush() releases
 * the rest. With no secret of MIN_SECRET_LENGTH or more, nothing is held: each
 * chunk passes through unchanged.
 */
import { MIN_SECRET_LENGTH, scrubSecrets } from "#src/client/text";

export interface StreamScrubber {
  /** Adds a chunk; returns the text that is safe to emit now (possibly ""). */
  push(chunk: string): string;
  /** Returns everything held back, scrubbed, and empties the hold. */
  flush(): string;
}

const PASS_THROUGH: StreamScrubber = { push: (chunk) => chunk, flush: () => "" };

/** `at`, moved back one when it would split a surrogate pair. */
function safeCut(text: string, at: number): number {
  if (at <= 0) return 0;
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

export function createStreamScrubber(secrets: readonly string[]): StreamScrubber {
  const active = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  if (active.length === 0) return PASS_THROUGH;
  const hold = Math.max(...active.map((secret) => secret.length)) - 1;
  let held = "";
  return {
    push(chunk) {
      const text = scrubSecrets(held + chunk, active);
      const cut = safeCut(text, text.length - hold);
      held = text.slice(cut);
      return text.slice(0, cut);
    },
    flush() {
      const rest = scrubSecrets(held, active);
      held = "";
      return rest;
    },
  };
}
```

- [ ] **Step 6: Run the tests**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/text.test.ts test/unit/client/tool-display.test.ts test/unit/client/stream-scrub.test.ts`
Expected: PASS, including every existing `tool-display` test (the rename keeps behaviour).

- [ ] **Step 7: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/text.ts packages/nax-agent-acp/src/client/tool-display.ts packages/nax-agent-acp/src/client/stream-scrub.ts packages/nax-agent-acp/test/unit/client/text.test.ts packages/nax-agent-acp/test/unit/client/tool-display.test.ts packages/nax-agent-acp/test/unit/client/stream-scrub.test.ts
git commit -m "feat(nax-agent-acp): stream scrubber and text helpers for turn events"
```

---

### Task 2: Usage: per-turn tokens and the cost meter (D5-a, D5-b, D5-h)

**Files:**
- Create: `packages/nax-agent-acp/src/client/usage.ts`
- Test: `packages/nax-agent-acp/test/unit/client/usage.test.ts`

**Interfaces:**
- Consumes: `isRecord` (`text.ts`); `TokenUsage`, `TurnEvent` (`@nathapp/nax-agent`).
- Produces:
  - `interface TurnSpend { readonly tokenUsage: TokenUsage; readonly costUsd: number; readonly costSource: "reported" | "unpriced" }`
  - `interface CostMeter { beginTurn(): void; observe(cost: unknown): void; settle(): { readonly costUsd: number; readonly costSource: "reported" | "unpriced" } }`
  - `createCostMeter(): CostMeter`
  - `tokenUsageOf(usage: unknown): TokenUsage`
  - `turnSpend(response: PromptResponse, meter: CostMeter): TurnSpend`
  - `usageEvent(spend: TurnSpend): TurnEvent`

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent-acp/test/unit/client/usage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createCostMeter, tokenUsageOf, turnSpend, usageEvent } from "#src/client/usage";

const usd = (amount: number) => ({ amount, currency: "USD" });

describe("tokenUsageOf (S4-5 D5-a: per turn, as reported)", () => {
  test("maps tokens; thoughts count as output; cache fields when reported", () => {
    expect(
      tokenUsageOf({
        totalTokens: 175,
        inputTokens: 100,
        outputTokens: 20,
        thoughtTokens: 5,
        cachedReadTokens: 50,
        cachedWriteTokens: 0,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 50, cacheWriteTokens: 0 });
  });

  test("absent or null cache fields stay absent, never 0", () => {
    expect(tokenUsageOf({ totalTokens: 3, inputTokens: 1, outputTokens: 2, cachedReadTokens: null })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  test("no usage, or malformed numbers, count as 0", () => {
    expect(tokenUsageOf(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tokenUsageOf(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tokenUsageOf(JSON.parse('{"inputTokens": -4, "outputTokens": "9", "thoughtTokens": 1.5}'))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("createCostMeter (S4-5 D5-b: cumulative readings, per-turn difference)", () => {
  test("turn 1 from zero, turn 2 the difference", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.004));
    meter.observe(usd(0.01));
    expect(meter.settle()).toEqual({ costUsd: 0.01, costSource: "reported" });
    meter.beginTurn();
    meter.observe(usd(0.025));
    const second = meter.settle();
    expect(second.costSource).toBe("reported");
    expect(second.costUsd).toBeCloseTo(0.015, 10);
  });

  test("a turn with no reading is unpriced and keeps the baseline: its spend lands in the next priced turn", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.01));
    meter.settle();
    meter.beginTurn();
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
    meter.beginTurn();
    meter.observe(usd(0.04));
    expect(meter.settle().costUsd).toBeCloseTo(0.03, 10);
  });

  test("a reading below the baseline (counter restarted) reports the raw reading", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.5));
    meter.settle();
    meter.beginTurn();
    meter.observe(usd(0.02));
    expect(meter.settle()).toEqual({ costUsd: 0.02, costSource: "reported" });
  });

  test("non-USD, non-finite, negative or malformed readings are ignored", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe({ amount: 3, currency: "EUR" });
    meter.observe({ amount: Number.NaN, currency: "USD" });
    meter.observe({ amount: -1, currency: "USD" });
    meter.observe(JSON.parse('{"amount": "1", "currency": "USD"}'));
    meter.observe(null);
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
  });

  test("beginTurn forgets readings of a turn that never settled; the baseline is unchanged", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.2));
    meter.beginTurn();
    expect(meter.settle()).toEqual({ costUsd: 0, costSource: "unpriced" });
    meter.beginTurn();
    meter.observe(usd(0.3));
    expect(meter.settle()).toEqual({ costUsd: 0.3, costSource: "reported" });
  });

  test("currency is matched trimmed and case-insensitively", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe({ amount: 0.1, currency: " usd " });
    expect(meter.settle()).toEqual({ costUsd: 0.1, costSource: "reported" });
  });
});

describe("turnSpend and usageEvent (S4-5 D5-h)", () => {
  test("a response with usage and a cost reading", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe(usd(0.01));
    const spend = turnSpend(
      { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20, cachedReadTokens: 4 } },
      meter,
    );
    expect(spend).toEqual({
      tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 4 },
      costUsd: 0.01,
      costSource: "reported",
    });
    expect(usageEvent(spend)).toEqual({
      type: "usage",
      round: 0,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 4,
      costUsd: 0.01,
      costSource: "reported",
    });
  });

  test("no usage and no cost: zeros, unpriced", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    const spend = turnSpend({ stopReason: "end_turn" }, meter);
    expect(usageEvent(spend)).toEqual({
      type: "usage",
      round: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costSource: "unpriced",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/usage.test.ts`
Expected: FAIL: `#src/client/usage` does not exist.

- [ ] **Step 3: Implement**

Create `packages/nax-agent-acp/src/client/usage.ts`:

```ts
/**
 * A turn's usage (S4 spec §6.7 usage, S4-5 D5-a, D5-b, D5-h). Tokens come from
 * PromptResponse.usage and are per turn as reported: Claude's adapter resets them
 * when a turn starts (D5-a). Output tokens include thought tokens; cache fields stay
 * absent when not reported. Cost comes from usage_update.cost, a cumulative USD
 * reading: the session's meter remembers the reading at the end of the last priced
 * turn (0 for a new agent process), and a turn's cost is its latest reading minus
 * that. A reading below the baseline means the agent's counter restarted, so the
 * raw reading is the turn's cost. No reading: costUsd 0, "unpriced", baseline kept.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { TokenUsage, TurnEvent } from "@nathapp/nax-agent";
import { isRecord } from "#src/client/text";

export interface TurnCost {
  readonly costUsd: number;
  readonly costSource: "reported" | "unpriced";
}

export interface TurnSpend extends TurnCost {
  readonly tokenUsage: TokenUsage;
}

export interface CostMeter {
  /** Starts a turn: forgets readings of a turn that never settled. */
  beginTurn(): void;
  /** A usage_update's `cost`: kept when it is a finite, non-negative USD amount. */
  observe(cost: unknown): void;
  /** The turn's cost; a priced turn moves the baseline to its latest reading. */
  settle(): TurnCost;
}

const UNPRICED: TurnCost = Object.freeze({ costUsd: 0, costSource: "unpriced" });

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usdAmount(cost: unknown): number | undefined {
  if (!isRecord(cost) || typeof cost.amount !== "number" || typeof cost.currency !== "string") return undefined;
  if (cost.currency.trim().toUpperCase() !== "USD") return undefined;
  return Number.isFinite(cost.amount) && cost.amount >= 0 ? cost.amount : undefined;
}

export function tokenUsageOf(usage: unknown): TokenUsage {
  if (!isRecord(usage)) return { inputTokens: 0, outputTokens: 0 };
  const cacheRead = count(usage.cachedReadTokens);
  const cacheWrite = count(usage.cachedWriteTokens);
  return {
    inputTokens: count(usage.inputTokens) ?? 0,
    outputTokens: (count(usage.outputTokens) ?? 0) + (count(usage.thoughtTokens) ?? 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

export function createCostMeter(): CostMeter {
  let baseline = 0;
  let latest: number | undefined;
  return {
    beginTurn() {
      latest = undefined;
    },
    observe(cost) {
      const amount = usdAmount(cost);
      if (amount !== undefined) latest = amount;
    },
    settle() {
      if (latest === undefined) return UNPRICED;
      const reading = latest;
      const delta = reading - baseline;
      baseline = reading;
      latest = undefined;
      return { costUsd: delta < 0 ? reading : delta, costSource: "reported" };
    },
  };
}

export function turnSpend(response: PromptResponse, meter: CostMeter): TurnSpend {
  return { tokenUsage: tokenUsageOf(response.usage), ...meter.settle() };
}

export function usageEvent(spend: TurnSpend): TurnEvent {
  const { tokenUsage } = spend;
  return {
    type: "usage",
    round: 0,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    ...(tokenUsage.cacheReadTokens === undefined ? {} : { cacheRead: tokenUsage.cacheReadTokens }),
    ...(tokenUsage.cacheWriteTokens === undefined ? {} : { cacheWrite: tokenUsage.cacheWriteTokens }),
    costUsd: spend.costUsd,
    costSource: spend.costSource,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/unit/client/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/usage.ts packages/nax-agent-acp/test/unit/client/usage.test.ts
git commit -m "feat(nax-agent-acp): per-turn token usage and a cumulative cost meter"
```

---
### Task 3: Tool calls on the event stream (D5-c to D5-f)

**Files:**
- Create: `packages/nax-agent-acp/src/client/tool-events.ts`
- Test: `packages/nax-agent-acp/test/unit/client/tool-events.test.ts`

**Interfaces:**
- Consumes: `cleanCallId` (Task 1, `tool-display.ts`); `capBytes`, `cleanLabel`, `isRecord`, `scrubDeep`, `scrubSecrets`, `stripControl`, `stripInvisible` (`text.ts`, Task 1); `capStrings`, `redactSecrets`, `TOOL_CALL_INPUT_BYTES`, `TOOL_RESULT_PREVIEW_BYTES`, `TurnEvent` (`@nathapp/nax-agent`).
- Produces:
  - `interface ToolEvents { onUpdate(update: unknown): void; announce(toolCall: unknown): void; flush(): void }`
  - `createToolEvents(emit: (event: TurnEvent) => void, secrets: readonly string[]): ToolEvents`
  - `inputOf(raw: unknown, secrets: readonly string[]): unknown`
  - `previewOf(call: { readonly content?: unknown; readonly rawOutput?: unknown }, secrets: readonly string[]): string`
  - `diffSummary(diff: Readonly<Record<string, unknown>>): string`
  - constants `MAX_TRACKED_CALLS = 512`, `TOOL_NAME_MAX_CHARS = 200`, `UNANSWERED_PREVIEW = "Not answered: the turn ended."`, `DIFF_COUNT_MAX_CHARS = 1024 * 1024`

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent-acp/test/unit/client/tool-events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { TurnEvent } from "@nathapp/nax-agent";
import {
  createToolEvents,
  DIFF_COUNT_MAX_CHARS,
  diffSummary,
  inputOf,
  MAX_TRACKED_CALLS,
  previewOf,
  UNANSWERED_PREVIEW,
} from "#src/client/tool-events";

const SECRET = "s3cr3t-token-value-0123";

function setup(secrets: readonly string[] = []) {
  const events: TurnEvent[] = [];
  const tools = createToolEvents((event) => events.push(event), secrets);
  return { events, tools };
}

const text = (t: string) => ({ type: "content", content: { type: "text", text: t } });

describe("createToolEvents: when a call is announced (D5-c)", () => {
  test("a pending call with streaming input emits nothing until it is used", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c1", name: "Read", title: "Read", kind: "read", status: "pending", rawInput: {} });
    tools.onUpdate({ toolCallId: "c1", rawInput: { file_path: "/w/a.ts" } });
    expect(events).toEqual([]);
    tools.onUpdate({ toolCallId: "c1", status: "completed", content: [text("body")] });
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { file_path: "/w/a.ts" } },
      { type: "tool_result", callId: "c1", isError: false, preview: "body" },
    ]);
  });

  test("in_progress announces; failed answers with isError", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c2", name: "Bash", status: "pending", rawInput: { command: "ls" } });
    tools.onUpdate({ toolCallId: "c2", status: "in_progress" });
    expect(events).toEqual([{ type: "tool_call", callId: "c2", name: "Bash", input: { command: "ls" } }]);
    tools.onUpdate({ toolCallId: "c2", status: "failed", content: [text("Permission denied: no")] });
    expect(events.at(-1)).toEqual({
      type: "tool_result",
      callId: "c2",
      isError: true,
      preview: "Permission denied: no",
    });
  });

  test("announce() (a permission request) emits tool_call once; a later in_progress does not repeat it", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c3", name: "Edit", status: "pending" });
    tools.announce({ toolCallId: "c3", title: "Edit a.ts", rawInput: { path: "a.ts" } });
    tools.onUpdate({ toolCallId: "c3", status: "in_progress" });
    expect(events).toEqual([{ type: "tool_call", callId: "c3", name: "Edit", input: { path: "a.ts" } }]);
  });

  test("announce() for a call never seen before tracks and announces it", () => {
    const { events, tools } = setup();
    tools.announce({ toolCallId: "fresh", title: "Run tests", kind: "execute" });
    expect(events).toEqual([{ type: "tool_call", callId: "fresh", name: "Run tests", input: {} }]);
  });
});

describe("createToolEvents: one result per announced call (D5-e)", () => {
  test("a repeated terminal update is ignored", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "c1", name: "Read", status: "completed", content: [text("a")] });
    tools.onUpdate({ toolCallId: "c1", status: "completed", content: [text("b")] });
    tools.onUpdate({ toolCallId: "c1", status: "failed" });
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
  });

  test("flush answers announced calls without a result, and only those", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "started", name: "Bash", status: "in_progress" });
    tools.onUpdate({ toolCallId: "done", name: "Read", status: "completed" });
    tools.onUpdate({ toolCallId: "never-used", name: "Grep", status: "pending" });
    tools.flush();
    tools.flush();
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.callId)).toEqual(["started", "done"]);
    expect(events.filter((e) => e.type === "tool_result")).toEqual([
      { type: "tool_result", callId: "done", isError: false, preview: "" },
      { type: "tool_result", callId: "started", isError: true, preview: UNANSWERED_PREVIEW },
    ]);
  });

  test("an update with no id, an unusable id, or an id holding a secret emits nothing", () => {
    const { events, tools } = setup([SECRET]);
    tools.onUpdate({ status: "completed" });
    tools.onUpdate({ toolCallId: 7, status: "completed" });
    tools.onUpdate({ toolCallId: `id-${SECRET}`, status: "completed" });
    tools.onUpdate("not an object");
    tools.announce(null);
    expect(events).toEqual([]);
  });

  test(`at most ${MAX_TRACKED_CALLS} calls are tracked per turn; known calls still complete`, () => {
    const { events, tools } = setup();
    for (let i = 0; i < MAX_TRACKED_CALLS; i += 1) tools.onUpdate({ toolCallId: `c${i}`, status: "pending" });
    tools.onUpdate({ toolCallId: "one-too-many", name: "X", status: "completed" });
    tools.onUpdate({ toolCallId: "c0", name: "Y", status: "completed" });
    expect(events.map((e) => ("callId" in e ? e.callId : ""))).toEqual(["c0", "c0"]);
  });
});

describe("createToolEvents: names (D5-d)", () => {
  const nameOf = (update: Record<string, unknown>): string | undefined => {
    const { events, tools } = setup([SECRET]);
    tools.onUpdate({ toolCallId: "n", status: "in_progress", ...update });
    const first = events[0];
    return first?.type === "tool_call" ? first.name : undefined;
  };

  test("the agent's tool name first, then a real title, then kind, then 'tool'", () => {
    expect(nameOf({ name: "mcp__nax__lookup", title: "Lookup", kind: "other" })).toBe("mcp__nax__lookup");
    expect(nameOf({ title: "Read a.ts", kind: "read" })).toBe("Read a.ts");
    expect(nameOf({ title: "Tool Call", kind: "execute" })).toBe("execute");
    expect(nameOf({ title: "TOOL" })).toBe("tool");
    expect(nameOf({})).toBe("tool");
  });

  test("the first real title is kept over later ones", () => {
    const { events, tools } = setup();
    tools.onUpdate({ toolCallId: "t", title: "tool call", status: "pending" });
    tools.onUpdate({ toolCallId: "t", title: "Read a.ts" });
    tools.onUpdate({ toolCallId: "t", title: "Read b.ts", status: "in_progress" });
    expect(events[0]).toMatchObject({ type: "tool_call", name: "Read a.ts" });
  });

  test("names are one line, visible, scrubbed and capped at 200 characters", () => {
    expect(nameOf({ name: `Bash\n‮${SECRET}` })).toBe("Bash [REDACTED]");
    expect(nameOf({ name: "n".repeat(500) })).toHaveLength(200);
  });
});

describe("inputOf and previewOf (D5-f)", () => {
  test("input: absent is {}; secrets scrubbed and redacted; small input kept as is", () => {
    expect(inputOf(undefined, [])).toEqual({});
    expect(inputOf(null, [])).toEqual({});
    expect(inputOf({ command: `curl ${SECRET}`, n: 1 }, [SECRET])).toEqual({ command: "curl [REDACTED]", n: 1 });
    expect(inputOf({ api_key: "abc123456789" }, [])).not.toEqual({ api_key: "abc123456789" });
  });

  test("input: over the JSON cap becomes { truncated, preview }", () => {
    const big = inputOf({ content: "x".repeat(20_000) }, []);
    expect(big).toMatchObject({ truncated: true });
    expect(JSON.stringify(big).length).toBeLessThan(9_000);
  });

  test("preview: text blocks, resource links and diffs, joined by newlines; terminals skipped", () => {
    expect(
      previewOf(
        {
          content: [
            text("line one"),
            { type: "content", content: { type: "resource_link", uri: "file:///w/a.ts", name: "a.ts" } },
            { type: "diff", path: "/w/b.ts", oldText: "a\nb\nc", newText: "a\nB\nc\nd" },
            { type: "terminal", terminalId: "t1" },
            { type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
          ],
        },
        [],
      ),
    ).toBe("line one\nfile:///w/a.ts\nedit /w/b.ts (+2 -1)");
  });

  test("preview: rawOutput string when there is no content; scrubbed, stripped, capped at 4096 bytes", () => {
    expect(previewOf({ rawOutput: `out ${SECRET}\u0007` }, [SECRET])).toBe("out [REDACTED]");
    expect(previewOf({ rawOutput: { not: "a string" } }, [])).toBe("");
    expect(Buffer.byteLength(previewOf({ content: [text("y".repeat(100_000))] }, []))).toBeLessThanOrEqual(4096);
  });

  test("diffSummary: a new file, a deletion, a missing path, and a diff too large to count", () => {
    expect(diffSummary({ path: "/w/new.ts", newText: "a\nb" })).toBe("edit /w/new.ts (+2 -0)");
    expect(diffSummary({ path: "/w/gone.ts", oldText: "a\nb", newText: "" })).toBe("edit /w/gone.ts (+0 -2)");
    expect(diffSummary({ newText: "a" })).toBe("edit (unknown path) (+1 -0)");
    const huge = "z\n".repeat(DIFF_COUNT_MAX_CHARS);
    expect(diffSummary({ path: "/w/huge.ts", oldText: "", newText: huge })).toBe("edit /w/huge.ts");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/tool-events.test.ts`
Expected: FAIL: `#src/client/tool-events` does not exist.

- [ ] **Step 3: Implement**

Create `packages/nax-agent-acp/src/client/tool-events.ts`:

```ts
/**
 * Tool calls on the turn's event stream (S4 spec §6.7 tool rows, S4-5 D5-c to D5-f).
 * tool_call and tool_call_update notifications are merged per call id, cleaned as
 * for approvals (cleanCallId), so tool_call.callId matches approval_requested.callId.
 * A call's tool_call event goes out when the call is used: a permission request
 * names it (announce), or it reports in_progress, completed or failed. Claude
 * streams a call's input after first reporting it, so the event carries the input
 * known at that moment (D5-c). completed/failed answers it with one tool_result;
 * flush() answers an announced call left without one with an error result, so every
 * tool_call has exactly one tool_result (D5-e). A call never used emits nothing. Its
 * name is the agent's tool name, else its first real title, else its kind (D5-d).
 * Input and preview are agent data: capped, scrubbed of the session's secret values
 * and redacted best-effort (D5-f). At most MAX_TRACKED_CALLS calls per turn.
 */
import {
  capStrings,
  redactSecrets,
  TOOL_CALL_INPUT_BYTES,
  TOOL_RESULT_PREVIEW_BYTES,
  type TurnEvent,
} from "@nathapp/nax-agent";
import {
  capBytes,
  cleanLabel,
  isRecord,
  scrubDeep,
  scrubSecrets,
  stripControl,
  stripInvisible,
} from "#src/client/text";
import { cleanCallId } from "#src/client/tool-display";

export const MAX_TRACKED_CALLS = 512;
export const TOOL_NAME_MAX_CHARS = 200;
export const UNANSWERED_PREVIEW = "Not answered: the turn ended.";
/** A diff larger than this (old plus new text, in characters) is shown without line counts. */
export const DIFF_COUNT_MAX_CHARS = 1024 * 1024;
/** Redaction scans at most this much of a string or a preview, as nax-agent's own emitter does. */
const REDACTION_SCAN_BYTES = TOOL_RESULT_PREVIEW_BYTES * 16;
const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set(["tool call", "tool"]);

export interface ToolEvents {
  /** A tool_call or tool_call_update of this turn. */
  onUpdate(update: unknown): void;
  /** A permission request names this call (a ToolCallUpdate): its tool_call goes out now. */
  announce(toolCall: unknown): void;
  /** Answers each announced call that has no result yet. */
  flush(): void;
}

interface CallState {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
  readonly content?: unknown;
  readonly rawOutput?: unknown;
  readonly announced: boolean;
  readonly resolved: boolean;
}

type Update = Readonly<Record<string, unknown>>;

function realTitle(value: unknown, secrets: readonly string[]): string | undefined {
  const title = cleanLabel(value, secrets, TOOL_NAME_MAX_CHARS);
  return title === undefined || PLACEHOLDER_TITLES.has(title.toLowerCase()) ? undefined : title;
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

function merged(state: CallState, update: Update, secrets: readonly string[]): CallState {
  const name = state.name ?? cleanLabel(update.name, secrets, TOOL_NAME_MAX_CHARS);
  const title = state.title ?? realTitle(update.title, secrets);
  const kind = cleanLabel(update.kind, secrets, TOOL_NAME_MAX_CHARS) ?? state.kind;
  return {
    ...state,
    ...(name === undefined ? {} : { name }),
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
    ...(present(update.rawInput) ? { rawInput: update.rawInput } : {}),
    ...(Array.isArray(update.content) ? { content: update.content } : {}),
    ...(present(update.rawOutput) ? { rawOutput: update.rawOutput } : {}),
  };
}

function nameOf(state: CallState): string {
  return state.name ?? state.title ?? state.kind ?? "tool";
}

export function inputOf(raw: unknown, secrets: readonly string[]): unknown {
  if (!present(raw)) return {};
  const redacted = redactSecrets(scrubDeep(capStrings(raw, REDACTION_SCAN_BYTES), secrets));
  let json: string;
  try {
    json = JSON.stringify(redacted) ?? "null";
  } catch {
    return { truncated: true, preview: "[input not serializable]" };
  }
  if (Buffer.byteLength(json, "utf8") <= TOOL_CALL_INPUT_BYTES) return redacted;
  return { truncated: true, preview: capBytes(json, TOOL_CALL_INPUT_BYTES) };
}

function lines(text: string): readonly string[] {
  return text === "" ? [] : text.split("\n");
}

/** Lines added and removed, as a multiset difference (linear time; moved lines count as unchanged). */
function lineDelta(oldText: string, newText: string): { readonly added: number; readonly removed: number } {
  const pool = new Map<string, number>();
  for (const line of lines(oldText)) pool.set(line, (pool.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(newText)) {
    const left = pool.get(line) ?? 0;
    if (left > 0) pool.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of pool.values()) removed += left;
  return { added, removed };
}

export function diffSummary(diff: Readonly<Record<string, unknown>>): string {
  const path = typeof diff.path === "string" && diff.path !== "" ? diff.path : "(unknown path)";
  const oldText = typeof diff.oldText === "string" ? diff.oldText : "";
  const newText = typeof diff.newText === "string" ? diff.newText : "";
  if (oldText.length + newText.length > DIFF_COUNT_MAX_CHARS) return `edit ${path}`;
  const { added, removed } = lineDelta(oldText, newText);
  return `edit ${path} (+${added} -${removed})`;
}

function contentPart(item: unknown): string {
  if (!isRecord(item)) return "";
  if (item.type === "diff") return diffSummary(item);
  if (item.type !== "content" || !isRecord(item.content)) return "";
  const block = item.content;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource_link" && typeof block.uri === "string") return block.uri;
  return "";
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map(contentPart)
    .filter((part) => part !== "")
    .join("\n");
}

export function previewOf(
  call: { readonly content?: unknown; readonly rawOutput?: unknown },
  secrets: readonly string[],
): string {
  const fromContent = contentText(call.content);
  let raw = fromContent;
  if (raw === "" && typeof call.rawOutput === "string") raw = call.rawOutput;
  const visible = stripInvisible(stripControl(capBytes(raw, REDACTION_SCAN_BYTES)));
  return capBytes(redactSecrets(scrubSecrets(visible, secrets)), TOOL_RESULT_PREVIEW_BYTES);
}

function isStarted(status: unknown): boolean {
  return status === "in_progress" || status === "completed" || status === "failed";
}

export function createToolEvents(emit: (event: TurnEvent) => void, secrets: readonly string[]): ToolEvents {
  const calls = new Map<string, CallState>();
  const merge = (update: unknown): CallState | undefined => {
    if (!isRecord(update)) return undefined;
    const id = cleanCallId(update.toolCallId, secrets);
    if (id === undefined) return undefined;
    const known = calls.get(id);
    if (known === undefined && calls.size >= MAX_TRACKED_CALLS) return undefined;
    const next = merged(known ?? { id, announced: false, resolved: false }, update, secrets);
    calls.set(id, next);
    return next;
  };
  const announce = (state: CallState): CallState => {
    if (state.announced) return state;
    const next = { ...state, announced: true };
    calls.set(state.id, next);
    emit({ type: "tool_call", callId: state.id, name: nameOf(state), input: inputOf(state.rawInput, secrets) });
    return next;
  };
  const resolve = (state: CallState, isError: boolean, preview: string): void => {
    if (state.resolved) return;
    calls.set(state.id, { ...state, resolved: true });
    emit({ type: "tool_result", callId: state.id, isError, preview });
  };
  return {
    onUpdate(update) {
      const state = merge(update);
      const status = isRecord(update) ? update.status : undefined;
      if (state === undefined || !isStarted(status)) return;
      const shown = announce(state);
      if (status !== "in_progress") resolve(shown, status === "failed", previewOf(shown, secrets));
    },
    announce(toolCall) {
      const state = merge(toolCall);
      if (state !== undefined) announce(state);
    },
    flush() {
      for (const state of [...calls.values()]) {
        if (state.announced) resolve(state, true, UNANSWERED_PREVIEW);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/unit/client/tool-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/tool-events.ts packages/nax-agent-acp/test/unit/client/tool-events.test.ts
git commit -m "feat(nax-agent-acp): tool call and result events from ACP tool updates"
```

---

### Task 4: The turn collector and usage on the turn (D5-g, D5-h)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/events.ts` (whole file)
- Modify: `packages/nax-agent-acp/src/client/turn.ts` (whole file)
- Test: `packages/nax-agent-acp/test/unit/client/events.test.ts` (whole file)

**Interfaces:**
- Consumes: `createStreamScrubber` (Task 1), `scrubSecrets` (`text.ts`), `createToolEvents` (Task 3), `createCostMeter`, `turnSpend`, `usageEvent`, `CostMeter`, `TurnSpend` (Task 2).
- Produces (`events.ts`):
  - `interface CollectorOptions { readonly secrets?: readonly string[]; readonly meter?: CostMeter }`
  - `interface TurnCollector { onUpdate(update: SessionUpdate): void; announce(toolCall: unknown): void; finish(): void; settle(response: PromptResponse): TurnSpend; output(): string }`
  - `createTurnCollector(emit: TurnEventSink | undefined, options?: CollectorOptions): TurnCollector` (calls `meter.beginTurn()` once)
- Produces (`turn.ts`): `runPromptTurn` unchanged in signature; the `TurnResult` now carries `tokenUsage`, `estimatedCostUsd` and `costSource` from `collector.settle(response)`.

- [ ] **Step 1: Write the failing test**

Replace `packages/nax-agent-acp/test/unit/client/events.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";
import { UNANSWERED_PREVIEW } from "#src/client/tool-events";
import { createCostMeter } from "#src/client/usage";

const SECRET = "s3cr3t-token-value-0123";

const say = (text: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const think = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});

function setup(secrets: readonly string[] = []) {
  const events: TurnEvent[] = [];
  const collector = createTurnCollector((e) => events.push(e), { secrets });
  return { events, collector };
}

describe("createTurnCollector: text and thoughts (spec §6.7, D5-g)", () => {
  test("agent text is text_delta and the output; thoughts are thinking_delta and not output", () => {
    const { events, collector } = setup();
    collector.onUpdate(say("Hel"));
    collector.onUpdate(think("hmm"));
    collector.onUpdate(say("lo"));
    expect(events).toEqual([
      { type: "text_delta", round: 0, text: "Hel" },
      { type: "thinking_delta", round: 0, text: "hmm" },
      { type: "text_delta", round: 0, text: "lo" },
    ]);
    expect(collector.output()).toBe("Hello");
  });

  test("a secret split across text chunks never reaches a delta whole or in joinable parts", () => {
    const { events, collector } = setup([SECRET]);
    collector.onUpdate(say("key s3cr3t-tok"));
    collector.onUpdate(say("en-value-0123 ok"));
    collector.finish();
    const deltas = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
    expect(deltas.join("")).toBe("key [REDACTED] ok");
    expect(collector.output()).toBe("key [REDACTED] ok");
  });

  test("held text flushes before the other stream and before tool events, keeping the order", () => {
    const { events, collector } = setup([SECRET]);
    collector.onUpdate(say("before"));
    collector.onUpdate(think("thinking"));
    collector.onUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", status: "in_progress" });
    collector.onUpdate(say("after"));
    collector.finish();
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "thinking_delta",
      "tool_call",
      "text_delta",
      "tool_result",
    ]);
  });

  test("non-text chunks, user chunks, plans and mode updates are dropped", () => {
    const { events, collector } = setup();
    collector.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "AA", mimeType: "image/png" } });
    collector.onUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "me" } });
    collector.onUpdate({ sessionUpdate: "plan", entries: [] });
    collector.onUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    collector.finish();
    expect(events).toEqual([]);
    expect(collector.output()).toBe("");
  });
});

describe("createTurnCollector: tools, finish and settle (D5-c, D5-e, D5-h)", () => {
  test("announce emits tool_call; finish answers it as not answered; nothing after finish", () => {
    const { events, collector } = setup();
    collector.announce({ toolCallId: "p1", title: "Edit a file", kind: "edit" });
    collector.finish();
    collector.onUpdate(say("late"));
    collector.announce({ toolCallId: "p2", title: "Late" });
    collector.finish();
    expect(events).toEqual([
      { type: "tool_call", callId: "p1", name: "Edit a file", input: {} },
      { type: "tool_result", callId: "p1", isError: true, preview: UNANSWERED_PREVIEW },
    ]);
  });

  test("settle emits one usage event after the last delta, with the meter's cost", () => {
    const events: TurnEvent[] = [];
    const meter = createCostMeter();
    const collector = createTurnCollector((e) => events.push(e), { secrets: [SECRET], meter });
    collector.onUpdate(say("tail s3cr3t"));
    collector.onUpdate({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.02, currency: "USD" } });
    const spend = collector.settle({
      stopReason: "end_turn",
      usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 },
    });
    expect(spend).toEqual({ tokenUsage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.02, costSource: "reported" });
    expect(events.map((e) => e.type)).toEqual(["text_delta", "usage"]);
    expect(events.at(-1)).toEqual({
      type: "usage",
      round: 0,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02,
      costSource: "reported",
    });
    expect(collector.settle({ stopReason: "end_turn" })).toBe(spend);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  test("the collector starts a meter turn: a reading from an unsettled earlier turn is forgotten", () => {
    const meter = createCostMeter();
    meter.beginTurn();
    meter.observe({ amount: 1, currency: "USD" });
    const collector = createTurnCollector(undefined, { meter });
    expect(collector.settle({ stopReason: "end_turn" }).costSource).toBe("unpriced");
  });

  test("a throwing sink does not break collection; no sink is allowed", () => {
    const collector = createTurnCollector(() => {
      throw new Error("sink broke");
    });
    collector.onUpdate(say("x"));
    expect(collector.output()).toBe("x");
    const silent = createTurnCollector(undefined);
    silent.onUpdate(say("y"));
    expect(silent.settle({ stopReason: "end_turn" }).costSource).toBe("unpriced");
    expect(silent.output()).toBe("y");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/events.test.ts`
Expected: FAIL: the current collector drops thoughts and tool updates, and has no `announce`, `finish` or `settle`.

- [ ] **Step 3: Replace `events.ts`**

Replace `packages/nax-agent-acp/src/client/events.ts` with:

```ts
/**
 * session/update -> TurnEvent (S4 spec §6.7, S4-5). Agent text is a text_delta and
 * a thought a thinking_delta, round 0. Both are scrubbed of the session's secret
 * values, holding back only the tail that could start a secret (D5-g); a delta of
 * one stream, and any tool event, first flushes what the other stream holds, so the
 * order is kept. Tool calls and results come from tool-events.ts (D5-c to D5-f);
 * usage_update costs feed the session's cost meter (D5-b). User chunks, plans, mode,
 * config and command updates, and anything unknown are dropped. finish() flushes
 * held text and answers unanswered tool calls; settle(response) does that and then
 * emits the turn's one usage event (D5-h). Nothing is emitted after finish(). The
 * sink is the facade's; a throw from it is contained.
 */
import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { TurnEvent, TurnEventSink } from "@nathapp/nax-agent";
import { createStreamScrubber } from "#src/client/stream-scrub";
import { scrubSecrets } from "#src/client/text";
import { createToolEvents } from "#src/client/tool-events";
import { type CostMeter, createCostMeter, type TurnSpend, turnSpend, usageEvent } from "#src/client/usage";

export interface CollectorOptions {
  /** The session's secret values: env secrets and the tool host's token. */
  readonly secrets?: readonly string[];
  /** The session's cost meter; a fresh one when absent. */
  readonly meter?: CostMeter;
}

export interface TurnCollector {
  onUpdate(update: SessionUpdate): void;
  /** A permission request names this tool call: its tool_call event goes out now (D5-c). */
  announce(toolCall: unknown): void;
  /** Flushes held text and answers announced calls without a result. Idempotent. */
  finish(): void;
  /** finish(), then the turn's one usage event; returns the turn's spend. */
  settle(response: PromptResponse): TurnSpend;
  /** The turn's agent message text, scrubbed (turn_end.output). */
  output(): string;
}

type DeltaType = "text_delta" | "thinking_delta";

interface Deltas {
  push(type: DeltaType, text: string): void;
  flushAll(): void;
}

function createDeltas(send: (event: TurnEvent) => void, secrets: readonly string[]): Deltas {
  const streams = { text_delta: createStreamScrubber(secrets), thinking_delta: createStreamScrubber(secrets) };
  const out = (type: DeltaType, text: string): void => {
    if (text !== "") send({ type, round: 0, text });
  };
  const flush = (type: DeltaType): void => out(type, streams[type].flush());
  return {
    push(type, text) {
      flush(type === "text_delta" ? "thinking_delta" : "text_delta");
      out(type, streams[type].push(text));
    },
    flushAll() {
      flush("thinking_delta");
      flush("text_delta");
    },
  };
}

function containedSink(emit: TurnEventSink | undefined): (event: TurnEvent) => void {
  return (event) => {
    try {
      emit?.(event);
    } catch {
      // The sink is the facade's event channel; a broken consumer must not break the turn.
    }
  };
}

export function createTurnCollector(emit: TurnEventSink | undefined, options: CollectorOptions = {}): TurnCollector {
  const secrets = options.secrets ?? [];
  const meter = options.meter ?? createCostMeter();
  meter.beginTurn();
  const send = containedSink(emit);
  const deltas = createDeltas(send, secrets);
  const tools = createToolEvents((event) => {
    deltas.flushAll();
    send(event);
  }, secrets);
  const parts: string[] = [];
  let done = false;
  let spend: TurnSpend | undefined;
  const route = (update: SessionUpdate): void => {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type !== "text") return;
        parts.push(update.content.text);
        deltas.push("text_delta", update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") deltas.push("thinking_delta", update.content.text);
        return;
      case "tool_call":
      case "tool_call_update":
        tools.onUpdate(update);
        return;
      case "usage_update":
        meter.observe(update.cost);
        return;
      default:
        return;
    }
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    deltas.flushAll();
    tools.flush();
  };
  return {
    onUpdate(update) {
      if (!done) route(update);
    },
    announce(toolCall) {
      if (!done) tools.announce(toolCall);
    },
    finish,
    settle(response) {
      finish();
      if (spend === undefined) {
        spend = turnSpend(response, meter);
        send(usageEvent(spend));
      }
      return spend;
    },
    output: () => scrubSecrets(parts.join(""), secrets),
  };
}
```

- [ ] **Step 4: Replace `turn.ts`**

Replace `packages/nax-agent-acp/src/client/turn.ts` with:

```ts
/**
 * One ACP prompt turn (S4 spec §6.3 steps 2 and 3, §5.7, §6.7). The response settles
 * the turn's collector first, so its usage event goes out for every stop reason
 * (S4-5 D5-h); end_turn then returns a TurnResult with the turn's tokens and cost,
 * and any other stop reason throws its ACP_STOP_* NaxError. When the turn signal
 * aborts (cancel(), the facade's turn timeout, close()), session/cancel is sent and
 * the prompt gets cancelGraceMs to settle; past that the process group is killed
 * and the session is marked disconnected. The facade reports cancelled or timed_out
 * from the signal, so after an abort this throws the signal's reason.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { NaxError, type TurnResult } from "@nathapp/nax-agent";
import type { AcpLink } from "#src/client/connection";
import { promptRequestError, rpcErrorOf, stopReasonError } from "#src/client/errors";
import type { TurnCollector } from "#src/client/events";
import { agentGoneError, type LaunchedAgent } from "#src/client/launch";
import { race } from "#src/client/race";

export interface TurnState {
  readonly link: AcpLink;
  readonly launched: LaunchedAgent;
  readonly agentSessionId: string;
  readonly cancelGraceMs: number;
  readonly secrets: readonly string[];
  /** Marks the session disconnected: its process is gone or was killed (D-f). */
  disconnect(): void;
}

export interface TurnInput {
  readonly text: string;
  readonly signal: AbortSignal;
  readonly collector: TurnCollector;
}

export async function runPromptTurn(state: TurnState, input: TurnInput): Promise<TurnResult> {
  const pending = state.link.prompt({
    sessionId: state.agentSessionId,
    prompt: [{ type: "text", text: input.text }],
  });
  const outcome = await race(pending, { signal: input.signal });
  switch (outcome.kind) {
    case "ok":
      return resultOf(outcome.value, input.collector);
    case "failed":
      throw await promptFailure(state, outcome.error);
    default:
      await cancelTurn(state, pending);
      throw abortReason(input.signal);
  }
}

function resultOf(response: PromptResponse, collector: TurnCollector): TurnResult {
  const spend = collector.settle(response);
  if (response.stopReason !== "end_turn") throw stopReasonError(String(response.stopReason));
  return {
    output: collector.output(),
    tokenUsage: spend.tokenUsage,
    estimatedCostUsd: spend.costUsd,
    costSource: spend.costSource,
    internalRoundTrips: 1,
  };
}

async function promptFailure(state: TurnState, error: unknown): Promise<NaxError> {
  const rpc = rpcErrorOf(error);
  if (rpc !== undefined) return promptRequestError(rpc, state.secrets);
  state.disconnect();
  return agentGoneError("session/prompt", state.launched, state.secrets);
}

async function cancelTurn(state: TurnState, pending: Promise<PromptResponse>): Promise<void> {
  await state.link.cancel(state.agentSessionId).catch(() => undefined);
  const settled = await race(pending, { timeoutMs: state.cancelGraceMs });
  if (settled.kind === "timeout") {
    state.launched.kill();
    state.disconnect();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new NaxError("The turn was aborted", "AGENT_SESSION_TURN_FAILED", { stage: "acp" });
}
```

- [ ] **Step 5: Update the two exact event sequences**

Every turn now ends with a `usage` event. In `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts` replace:

```ts
    expect(types(events)).toEqual(["turn_start", "approval_requested", "approval_resolved", "text_delta", "turn_end"]);
```

with:

```ts
    expect(types(events)).toEqual([
      "turn_start",
      "approval_requested",
      "approval_resolved",
      "text_delta",
      "usage",
      "turn_end",
    ]);
```

and replace:

```ts
    expect(types(events)).toEqual(["turn_start", "text_delta", "turn_end"]);
```

with:

```ts
    expect(types(events)).toEqual(["turn_start", "text_delta", "usage", "turn_end"]);
```

(Task 6 adds the announced `tool_call` and its `tool_result` to the first sequence.)

- [ ] **Step 6: Run the package suite**

Run (from `packages/nax-agent-acp`): `bun run test`
Expected: PASS. `inbound.test.ts` still builds collectors with `createTurnCollector(undefined)`, which stays valid, and the backend tests see real (zero, `unpriced`) usage because the fake reports none.

- [ ] **Step 7: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/events.ts packages/nax-agent-acp/src/client/turn.ts packages/nax-agent-acp/test/unit/client/events.test.ts packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts
git commit -m "feat(nax-agent-acp): thoughts, tool events and usage on ACP turns"
```

---
### Task 5: Elicitation as questions (D5-i)

**Files:**
- Create: `packages/nax-agent-acp/src/client/elicitation.ts`
- Test: `packages/nax-agent-acp/test/unit/client/elicitation.test.ts`

**Interfaces:**
- Consumes: `SessionAskPort.askQuestion(text, { signal })` (Task 0); `capBytes`, `isRecord`, `scrubSecrets`, `stripControl`, `stripInvisible` (`text.ts`).
- Produces:
  - `interface ElicitationContext { readonly profile: AgentSessionProfile; readonly asks: SessionAskPort; readonly secrets: readonly string[]; readonly signal: AbortSignal }`
  - `answerElicitation(request: CreateElicitationRequest, ctx: ElicitationContext): Promise<CreateElicitationResponse>`
  - constants `QUESTION_MAX_BYTES = 4096`, `MAX_FORM_FIELDS = 16`, `MAX_CHOICES = 32`, `NO_MATCH_NOTE`, `REQUIRED_NOTE`

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent-acp/test/unit/client/elicitation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, SessionAskPort } from "@nathapp/nax-agent";
import {
  answerElicitation,
  type ElicitationContext,
  MAX_CHOICES,
  MAX_FORM_FIELDS,
  NO_MATCH_NOTE,
  QUESTION_MAX_BYTES,
  REQUIRED_NOTE,
} from "#src/client/elicitation";

const SECRET = "s3cr3t-token-value-0123";

function askPort(replies: readonly (string | null)[]) {
  const questions: string[] = [];
  const notes: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const asks: SessionAskPort = {
    requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
    recordAutoDecision: () => {},
    askQuestion: async (text, opts) => {
      questions.push(text);
      signals.push(opts?.signal);
      return replies[questions.length - 1] ?? null;
    },
    noteQuestion: (text) => {
      notes.push(text);
    },
  };
  return { asks, questions, notes, signals };
}

function context(asks: SessionAskPort, extra: Partial<ElicitationContext> = {}): ElicitationContext {
  return { profile: "ask", asks, secrets: [SECRET], signal: new AbortController().signal, ...extra };
}

/** A form request as the agent sends it; JSON.parse keeps malformed shapes possible without casts. */
function form(
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  message = "Pick one",
): CreateElicitationRequest {
  return JSON.parse(
    JSON.stringify({ mode: "form", sessionId: "s", message, requestedSchema: { type: "object", properties, ...extra } }),
  );
}

/** Claude's AskUserQuestion with one single-select question (elicitation.js askUserQuestionsToCreateRequest). */
const CLAUDE_SINGLE = form({
  question_0: {
    type: "string",
    title: "Auth",
    oneOf: [
      { const: "OAuth", title: "OAuth", description: "Browser login" },
      { const: "API key", title: "API key" },
    ],
  },
  question_0_custom: { type: "string", title: "Other", description: "Type your own answer (optional)." },
});

async function answer(request: CreateElicitationRequest, replies: readonly (string | null)[], profile: AgentSessionProfile = "ask") {
  const port = askPort(replies);
  const response = await answerElicitation(request, context(port.asks, { profile }));
  return { response, ...port };
}

describe("answerElicitation: Claude's AskUserQuestion forms (D5-i)", () => {
  test("one question: message, header, numbered choices and the instruction; a number picks a choice", async () => {
    const { response, questions } = await answer(CLAUDE_SINGLE, ["2"]);
    expect(response).toEqual({ action: "accept", content: { question_0: "API key" } });
    expect(questions).toEqual([
      [
        "Pick one",
        "Auth",
        "1. OAuth - Browser login",
        "2. API key",
        "Reply with one number or choice, or type your own answer. Leave empty to skip.",
      ].join("\n"),
    ]);
  });

  test("a choice's text in any case, trimmed, picks it", async () => {
    expect((await answer(CLAUDE_SINGLE, ["  oauth "])).response).toEqual({
      action: "accept",
      content: { question_0: "OAuth" },
    });
  });

  test("a reply naming no choice becomes the custom answer", async () => {
    expect((await answer(CLAUDE_SINGLE, ["Use mTLS"])).response).toEqual({
      action: "accept",
      content: { question_0_custom: "Use mTLS" },
    });
  });

  test("an empty reply skips the optional question", async () => {
    expect((await answer(CLAUDE_SINGLE, [""])).response).toEqual({ action: "accept", content: {} });
  });

  test("several questions with a multi-select: one question each, comma lists, extras go to the custom field", async () => {
    const request = form(
      {
        question_0: { type: "string", title: "Auth", description: "Which auth method?", oneOf: [{ const: "OAuth", title: "OAuth" }] },
        question_0_custom: { type: "string", title: "Other" },
        question_1: {
          type: "array",
          title: "Cache",
          description: "Which caches?",
          items: { anyOf: [{ const: "Redis", title: "Redis" }, { const: "Memcached", title: "Memcached" }] },
        },
        question_1_custom: { type: "string", title: "Other" },
      },
      {},
      "Please answer the following questions.",
    );
    const { response, questions } = await answer(request, ["1", "redis, 2, Hazelcast, Redis"]);
    expect(response).toEqual({
      action: "accept",
      content: { question_0: "OAuth", question_1: ["Redis", "Memcached"], question_1_custom: "Hazelcast" },
    });
    expect(questions).toHaveLength(2);
    expect(questions[0]?.split("\n").slice(0, 2)).toEqual([
      "Please answer the following questions.",
      "(1/2) Auth: Which auth method?",
    ]);
    expect(questions[1]?.split("\n")[0]).toBe("(2/2) Cache: Which caches?");
    expect(questions[1]).toContain("Reply with numbers or choices, separated by commas, or type your own answer.");
  });
});

describe("answerElicitation: other forms (D5-i)", () => {
  test("message only: the message is asked; any reply accepts with empty content", async () => {
    const { response, questions } = await answer(form({}), ["ok"]);
    expect(response).toEqual({ action: "accept", content: {} });
    expect(questions).toEqual(["Pick one"]);
  });

  test("a single string field takes the reply as written", async () => {
    const request = form({ name: { type: "string", title: "Branch name" } });
    const { response, questions } = await answer(request, ["feat/x"]);
    expect(response).toEqual({ action: "accept", content: { name: "feat/x" } });
    expect(questions[0]).toBe("Pick one\nBranch name\nReply with your answer, or leave it empty to skip.");
  });

  test("an untitled enum matches by value", async () => {
    const request = form({ env: { type: "string", enum: ["staging", "prod"] } });
    expect((await answer(request, ["PROD"])).response).toEqual({ action: "accept", content: { env: "prod" } });
  });

  test("Claude's refusal-fallback prompt: a single oneOf field with no companion", async () => {
    const request = form({
      choice: {
        type: "string",
        oneOf: [
          { const: "retry_fallback", title: "Retry with Opus" },
          { const: "keep_refusal", title: "Keep the refusal" },
        ],
      },
    });
    expect((await answer(request, ["retry with opus"])).response).toEqual({
      action: "accept",
      content: { choice: "retry_fallback" },
    });
  });

  test("a reply naming no choice, with no companion, declines with a note", async () => {
    const request = form({ env: { type: "string", enum: ["staging", "prod"] } });
    const { response, notes } = await answer(request, ["qa"]);
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual([NO_MATCH_NOTE]);
  });

  test("an empty reply to a required field declines with a note", async () => {
    const request = form({ name: { type: "string" } }, { required: ["name"] });
    const { response, notes } = await answer(request, ["  "]);
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual([REQUIRED_NOTE]);
  });

  test("no reply cancels, and later questions are not asked", async () => {
    const request = form({ a: { type: "string" }, b: { type: "string" } });
    const { response, questions } = await answer(request, [null, "never asked"]);
    expect(response).toEqual({ action: "cancel" });
    expect(questions).toHaveLength(1);
  });

  test("a __proto__ field is answered as data", async () => {
    const request = form(JSON.parse('{"__proto__": {"type": "string"}}'));
    const { response } = await answer(request, ["x"]);
    expect(response.action).toBe("accept");
    expect(Object.prototype).not.toHaveProperty("type");
    expect(Object.getOwnPropertyNames("content" in response ? response.content : {})).toEqual(["__proto__"]);
  });
});

describe("answerElicitation: declined before asking (D5-i)", () => {
  test.each([
    ["a number field", { n: { type: "number" } }],
    ["a boolean field", { b: { type: "boolean" } }],
    ["an unknown type", { x: { type: "_custom" } }],
    ["an empty enum", { e: { type: "string", enum: [] } }],
    ["a malformed choice", { e: { type: "string", oneOf: [{ title: "no const" }] } }],
    ["too many choices", { e: { type: "string", enum: Array.from({ length: MAX_CHOICES + 1 }, (_, i) => `c${i}`) } }],
    ["a multi-select without choices", { m: { type: "array", items: { type: "string" } } }],
    [
      "too many fields",
      Object.fromEntries(Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => [`f${i}`, { type: "string" }])),
    ],
  ])("%s: noted and declined, nothing asked", async (_label, properties) => {
    const { response, questions, notes } = await answer(form(properties), ["x"]);
    expect(response).toEqual({ action: "decline" });
    expect(questions).toEqual([]);
    expect(notes).toEqual(["declined: Pick one"]);
  });

  test("a url-mode request is noted and declined", async () => {
    const request: CreateElicitationRequest = {
      mode: "url",
      sessionId: "s",
      message: "Log in",
      elicitationId: "e1",
      url: "https://example.com",
    };
    const { response, notes } = await answer(request, ["x"]);
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual(["declined: Log in"]);
  });

  test("under none and read: declined with no question and no note", async () => {
    for (const profile of ["none", "read"] as const) {
      const { response, questions, notes } = await answer(CLAUDE_SINGLE, ["1"], profile);
      expect(response).toEqual({ action: "decline" });
      expect(questions).toEqual([]);
      expect(notes).toEqual([]);
    }
  });
});

describe("answerElicitation: signal and hygiene (D5-i, D5-j)", () => {
  test("each question is asked under the context's signal", async () => {
    const port = askPort(["1"]);
    const signal = new AbortController().signal;
    await answerElicitation(CLAUDE_SINGLE, context(port.asks, { signal }));
    expect(port.signals).toHaveLength(1);
    expect(port.signals[0]).toBe(signal);
  });

  test("an aborted signal cancels without asking", async () => {
    const port = askPort(["1"]);
    const response = await answerElicitation(CLAUDE_SINGLE, context(port.asks, { signal: AbortSignal.abort() }));
    expect(response).toEqual({ action: "cancel" });
    expect(port.questions).toEqual([]);
  });

  test("a throwing ask port cancels", async () => {
    const port = askPort([]);
    const asks: SessionAskPort = {
      ...port.asks,
      askQuestion: async () => {
        throw new Error("port broke");
      },
    };
    expect(await answerElicitation(CLAUDE_SINGLE, context(asks))).toEqual({ action: "cancel" });
  });

  test("question text is stripped, scrubbed and capped", async () => {
    const message = `Use ${SECRET}?‮\u0007 ${"m".repeat(10_000)}`;
    const { questions } = await answer(form({}, {}, message), ["y"]);
    expect(questions[0]).not.toContain(SECRET);
    expect(questions[0]).not.toContain("‮");
    expect(questions[0]).not.toContain("\u0007");
    expect(Buffer.byteLength(questions[0] ?? "")).toBeLessThanOrEqual(QUESTION_MAX_BYTES);
  });

  test("a declined form's note is scrubbed too", async () => {
    const { notes } = await answer(form({ n: { type: "number" } }, {}, `token ${SECRET}`), []);
    expect(notes).toEqual(["declined: token [REDACTED]"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/elicitation.test.ts`
Expected: FAIL: `#src/client/elicitation` does not exist.

- [ ] **Step 3: Implement**

Create `packages/nax-agent-acp/src/client/elicitation.ts`:

```ts
/**
 * elicitation/create -> question events (S4 spec §6.8 as amended by S4-5 D5-i).
 * Advertised under `ask` and `full` only; under `none` and `read` a request is
 * declined unasked. A form is asked one field at a time through the session's ask
 * port, under the turn binding's signal (D5-j):
 * - no fields: the message alone; a reply accepts with empty content
 * - a string field: the reply, as written
 * - a single-select (`enum` or `oneOf`): a choice named by number, value or title,
 *   trimmed and case-insensitive
 * - a multi-select (`array` with `enum`/`anyOf`/`oneOf` items): comma-separated choices
 * A plain string field `<key>_custom` next to a select `<key>` is its free-text
 * companion (Claude's AskUserQuestion "Other" box): not asked on its own; a reply
 * naming no choice becomes its value. Any other field type, a malformed or oversized
 * choice list, too many fields, or a non-form request declines the form unasked;
 * a reply naming no choice without a companion, or an empty reply to a required
 * field, declines after asking. Each decline is noted with noteQuestion. No reply
 * (deadline, cancel, turn end, process exit) cancels. Question text is agent data:
 * control and invisible characters stripped, secrets scrubbed, capped.
 */
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from "@agentclientprotocol/sdk";
import type { AgentSessionProfile, SessionAskPort } from "@nathapp/nax-agent";
import { capBytes, isRecord, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

export const QUESTION_MAX_BYTES = 4096;
export const MAX_FORM_FIELDS = 16;
export const MAX_CHOICES = 32;
export const NO_MATCH_NOTE = "declined: the reply matches no choice";
export const REQUIRED_NOTE = "declined: an answer is required";
const COMPANION_SUFFIX = "_custom";
/** Agent text longer than this is cut before cleaning; a question is far shorter. */
const QUESTION_SCAN_BYTES = 64 * 1024;

export interface ElicitationContext {
  readonly profile: AgentSessionProfile;
  readonly asks: SessionAskPort;
  readonly secrets: readonly string[];
  /** The turn binding's signal: aborts on cancel, timeout, turn end and process exit. */
  readonly signal: AbortSignal;
}

interface Choice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface Field {
  readonly key: string;
  readonly kind: "text" | "single" | "multi";
  readonly title?: string;
  readonly description?: string;
  readonly choices: readonly Choice[];
  readonly required: boolean;
  readonly companion?: string;
}

type Content = Readonly<Record<string, ElicitationContentValue>>;
type Parsed = { readonly ok: true; readonly fields: readonly Field[] } | { readonly ok: false };
type Reply = { readonly ok: true; readonly content: Content } | { readonly ok: false; readonly note: string };

const CANCEL: CreateElicitationResponse = { action: "cancel" };
const DECLINE: CreateElicitationResponse = { action: "decline" };
const REFUSED: Parsed = { ok: false };

function shown(text: string, secrets: readonly string[]): string {
  const visible = stripInvisible(stripControl(capBytes(text, QUESTION_SCAN_BYTES)));
  return capBytes(scrubSecrets(visible, secrets), QUESTION_MAX_BYTES);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function choiceOf(item: unknown): Choice | undefined {
  if (typeof item === "string") return { value: item, label: item };
  if (!isRecord(item) || typeof item.const !== "string") return undefined;
  const description = nonEmpty(item.description);
  return {
    value: item.const,
    label: nonEmpty(item.title) ?? item.const,
    ...(description === undefined ? {} : { description }),
  };
}

/** [] when the schema declares no choices; undefined when its choice list is unusable. */
function choicesOf(schema: Readonly<Record<string, unknown>>): readonly Choice[] | undefined {
  const list = schema.oneOf ?? schema.anyOf ?? schema.enum;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHOICES) return undefined;
  const choices = list.map(choiceOf);
  return choices.every((choice): choice is Choice => choice !== undefined) ? choices : undefined;
}

function fieldOf(key: string, schema: unknown, required: boolean): Field | undefined {
  if (!isRecord(schema)) return undefined;
  const title = nonEmpty(schema.title);
  const description = nonEmpty(schema.description);
  const base = {
    key,
    required,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
  if (schema.type === "string") {
    const choices = choicesOf(schema);
    if (choices === undefined) return undefined;
    return { ...base, kind: choices.length === 0 ? "text" : "single", choices };
  }
  if (schema.type !== "array" || !isRecord(schema.items)) return undefined;
  const choices = choicesOf(schema.items);
  return choices === undefined || choices.length === 0 ? undefined : { ...base, kind: "multi", choices };
}

/** Folds each `<key>_custom` text field into its select `<key>` (D5-i). */
function withCompanions(fields: readonly Field[]): readonly Field[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const folded = new Set<string>();
  const linked = fields.map((field) => {
    const companion = byKey.get(`${field.key}${COMPANION_SUFFIX}`);
    if (field.kind === "text" || companion?.kind !== "text") return field;
    folded.add(companion.key);
    return { ...field, companion: companion.key };
  });
  return linked.filter((field) => !folded.has(field.key));
}

function parseForm(request: unknown): Parsed {
  if (!isRecord(request) || request.mode !== "form" || !isRecord(request.requestedSchema)) return REFUSED;
  const schema = request.requestedSchema;
  const properties = schema.properties ?? {};
  if (!isRecord(properties)) return REFUSED;
  const entries = Object.entries(properties);
  if (entries.length > MAX_FORM_FIELDS) return REFUSED;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = entries.map(([key, property]) => fieldOf(key, property, required.has(key)));
  return fields.every((field): field is Field => field !== undefined)
    ? { ok: true, fields: withCompanions(fields) }
    : REFUSED;
}

function instruction(field: Field): string {
  const own = field.companion === undefined ? "" : ", or type your own answer";
  const skip = field.required ? "" : " Leave empty to skip.";
  if (field.kind === "single") return `Reply with one number or choice${own}.${skip}`;
  if (field.kind === "multi") return `Reply with numbers or choices, separated by commas${own}.${skip}`;
  return field.required ? "Reply with your answer." : "Reply with your answer, or leave it empty to skip.";
}

function questionText(message: string, field: Field, index: number, count: number): string {
  const head = count > 1 ? `(${index + 1}/${count}) ` : "";
  const label = [field.title, field.description].filter((part) => part !== undefined).join(": ");
  const heading = `${head}${label}`.trim();
  return [
    ...(index === 0 && message.trim() !== "" ? [message.trim()] : []),
    ...(heading === "" ? [] : [heading]),
    ...field.choices.map((choice, i) => `${i + 1}. ${choice.label}${choice.description ? ` - ${choice.description}` : ""}`),
    instruction(field),
  ].join("\n");
}

function matchChoice(choices: readonly Choice[], text: string): Choice | undefined {
  const byNumber = /^\d+$/.test(text) ? choices[Number(text) - 1] : undefined;
  const wanted = text.toLowerCase();
  return byNumber ?? choices.find((c) => c.value.toLowerCase() === wanted || c.label.toLowerCase() === wanted);
}

const accepted = (content: Content): Reply => ({ ok: true, content });
const NO_MATCH: Reply = { ok: false, note: NO_MATCH_NOTE };

function singleReply(field: Field, reply: string): Reply {
  const choice = matchChoice(field.choices, reply);
  if (choice !== undefined) return accepted({ [field.key]: choice.value });
  return field.companion === undefined || field.required ? NO_MATCH : accepted({ [field.companion]: reply });
}

function multiReply(field: Field, reply: string): Reply {
  const parts = reply
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const matched = parts.map((part) => matchChoice(field.choices, part));
  const values = [...new Set(matched.flatMap((choice) => (choice === undefined ? [] : [choice.value])))];
  const others = parts.filter((_, i) => matched[i] === undefined);
  if (others.length > 0 && field.companion === undefined) return NO_MATCH;
  if (values.length === 0 && field.required) return NO_MATCH;
  return accepted({
    ...(values.length === 0 ? {} : { [field.key]: values }),
    ...(others.length === 0 || field.companion === undefined ? {} : { [field.companion]: others.join(", ") }),
  });
}

function applyReply(field: Field, reply: string): Reply {
  if (reply === "") return field.required ? { ok: false, note: REQUIRED_NOTE } : accepted({});
  if (field.kind === "single") return singleReply(field, reply);
  if (field.kind === "multi") return multiReply(field, reply);
  return accepted({ [field.key]: reply });
}

async function ask(text: string, ctx: ElicitationContext): Promise<string | null> {
  if (ctx.signal.aborted) return null;
  return ctx.asks.askQuestion(shown(text, ctx.secrets), { signal: ctx.signal }).catch(() => null);
}

async function askFields(
  message: string,
  fields: readonly Field[],
  ctx: ElicitationContext,
): Promise<CreateElicitationResponse> {
  if (fields.length === 0) return (await ask(message, ctx)) === null ? CANCEL : { action: "accept", content: {} };
  let content: Content = {};
  for (const [index, field] of fields.entries()) {
    const reply = await ask(questionText(message, field, index, fields.length), ctx);
    if (reply === null) return CANCEL;
    const outcome = applyReply(field, reply.trim());
    if (!outcome.ok) {
      ctx.asks.noteQuestion(outcome.note);
      return DECLINE;
    }
    content = { ...content, ...outcome.content };
  }
  return { action: "accept", content };
}

export async function answerElicitation(
  request: CreateElicitationRequest,
  ctx: ElicitationContext,
): Promise<CreateElicitationResponse> {
  if (ctx.profile !== "ask" && ctx.profile !== "full") return DECLINE;
  const message = typeof request.message === "string" ? request.message : "";
  const parsed = parseForm(request);
  if (!parsed.ok) {
    ctx.asks.noteQuestion(shown(`declined: ${message}`, ctx.secrets));
    return DECLINE;
  }
  return askFields(message, parsed.fields, ctx);
}
```

- [ ] **Step 4: Run the test**

Run: `bun test test/unit/client/elicitation.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0. If `check:complexity` flags a function over 20, split that function along its existing branches; do not raise the limit.

```bash
git add packages/nax-agent-acp/src/client/elicitation.ts packages/nax-agent-acp/test/unit/client/elicitation.test.ts
git commit -m "feat(nax-agent-acp): elicitation forms asked as questions, one field at a time"
```

---
### Task 6: Wiring: connection, inbound routing, open, backend, the fake agent (D5-c, D5-k, D5-l, D5-m)

**Files:**
- Modify: `packages/nax-agent-acp/src/client/connection.ts` (whole file)
- Modify: `packages/nax-agent-acp/src/client/inbound.ts` (whole file)
- Modify: `packages/nax-agent-acp/src/client/open.ts` (imports, header, `establish`, one new function)
- Modify: `packages/nax-agent-acp/src/client/backend.ts` (whole file)
- Modify: `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`, `test/fixtures/fake-agent/agent.ts`
- Test: `test/unit/client/connection.test.ts`, `test/unit/client/inbound.test.ts`, `test/unit/client/open.test.ts`, `test/unit/client/backend-permissions.test.ts`

**Interfaces:**
- Consumes: `answerElicitation`, `ElicitationContext` (Task 5); `createTurnCollector`, `TurnCollector` with `announce` and `finish` (Task 4); `createCostMeter`, `CostMeter` (Task 2).
- Produces:
  - `InboundHandlers.onElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>` (`connection.ts`)
  - `type ElicitationHandler = (request: CreateElicitationRequest, signal: AbortSignal) => Promise<CreateElicitationResponse>`; `createInboundRouter(decide: PermissionDecider, elicit?: ElicitationHandler): InboundRouter` (`inbound.ts`)
  - `clientCapabilitiesFor(profile: AgentSessionProfile): ClientCapabilities` (`open.ts`, exported for its test)
  - fake agent: `FakeStep` gains `{ kind: "update"; update: SessionUpdate }` and `ElicitStep`; the `text` step gains `echoMcpAuth?: boolean`; records `elicitation-answer` (the response) and `elicitation-error` (`{ message }`)

- [ ] **Step 1: The fake agent's new steps**

In `packages/nax-agent-acp/test/fixtures/fake-agent/script.ts`, replace the import:

```ts
import type {
  AgentCapabilities,
  PermissionOptionKind,
  SessionConfigOption,
  StopReason,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk";
```

with:

```ts
import type {
  AgentCapabilities,
  ElicitationSchema,
  PermissionOptionKind,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
  Usage,
} from "@agentclientprotocol/sdk";
```

Replace:

```ts
export type FakeStep =
  /** An agent_message_chunk; `sessionId` addresses another session (routing tests). */
  | { readonly kind: "text"; readonly text: string; readonly sessionId?: string }
  | { readonly kind: "thought"; readonly text: string }
```

with:

```ts
export type FakeStep =
  /**
   * An agent_message_chunk; `sessionId` addresses another session (routing tests);
   * `echoMcpAuth` appends the tool host's Authorization value (scrubbing tests, S4-5).
   */
  | { readonly kind: "text"; readonly text: string; readonly sessionId?: string; readonly echoMcpAuth?: boolean }
  | { readonly kind: "thought"; readonly text: string }
  /** Any session/update for the prompt's session: tool calls, usage, plans (S4-5 D5-m). */
  | { readonly kind: "update"; readonly update: SessionUpdate }
  /** elicitation/create (S4-5 D5-m). */
  | ElicitStep
```

and add after the `McpCallStep` interface:

```ts
/** Records `elicitation-answer` (the response) or `elicitation-error` `{ message }`. */
export interface ElicitStep {
  readonly kind: "elicit";
  readonly message: string;
  /** Absent: a message-only form (no properties). */
  readonly requestedSchema?: ElicitationSchema;
  /** Default "form"; "url" sends a url-mode request. */
  readonly mode?: "form" | "url";
  /** Default "session" (the prompt's session); "request" is request-scoped; "other" names another session. */
  readonly scope?: "session" | "request" | "other";
  /** Sent without waiting for the answer; `settled` waits for it. */
  readonly detached?: boolean;
}
```

In `packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts`, replace the imports:

```ts
import {
  type AgentApp,
  type AgentContext,
  agent,
  type McpServer,
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { callMcpTool, httpServerOf } from "./mcp.ts";
import type { FakeHooks, FakeScript, FakeStep, FakeTurn, McpCallStep, PermissionStep, RpcFailure } from "./script.ts";
```

with:

```ts
import {
  type AgentApp,
  type AgentContext,
  agent,
  type CreateElicitationRequest,
  type McpServer,
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { callMcpTool, httpServerOf } from "./mcp.ts";
import type {
  ElicitStep,
  FakeHooks,
  FakeScript,
  FakeStep,
  FakeTurn,
  McpCallStep,
  PermissionStep,
  RpcFailure,
} from "./script.ts";
```

Replace the header comment's first sentence:

```ts
 * The fake ACP agent (S4 spec §9) on the SDK's agent side. It answers initialize,
 * session/new, session/set_config_option, session/prompt and session/close from a
 * FakeScript and records each request through FakeHooks. It runs in process (the
```

with:

```ts
 * The fake ACP agent (S4 spec §9) on the SDK's agent side. It answers initialize,
 * session/new, session/set_config_option, session/prompt and session/close from a
 * FakeScript, sends updates, permission requests, MCP calls and elicitations as its
 * steps say, and records each request through FakeHooks. It runs in process (the
```

Replace in `runStep`:

```ts
    case "text":
      await client.notify(methods.client.session.update, {
        sessionId: step.sessionId ?? sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } },
      });
      return undefined;
```

with:

```ts
    case "text": {
      const auth = step.echoMcpAuth === true ? (httpServerOf(state.mcpServers)?.headers.Authorization ?? "") : "";
      await client.notify(methods.client.session.update, {
        sessionId: step.sessionId ?? sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${step.text}${auth}` } },
      });
      return undefined;
    }
    case "update":
      await client.notify(methods.client.session.update, { sessionId, update: step.update });
      return undefined;
    case "elicit":
      await elicit(step, sessionId, client, state, hooks);
      return undefined;
```

Add after the `requestPermission` function:

```ts
function elicitationRequest(step: ElicitStep, sessionId: string): CreateElicitationRequest {
  const scope =
    step.scope === "request"
      ? { requestId: "fake-request-1" }
      : { sessionId: step.scope === "other" ? "other-session" : sessionId };
  if (step.mode === "url") {
    return { ...scope, mode: "url", message: step.message, elicitationId: "fake-elicitation-1", url: "https://example.com/auth" };
  }
  const requestedSchema = step.requestedSchema ?? { type: "object", properties: {} };
  return { ...scope, mode: "form", message: step.message, requestedSchema };
}

async function elicit(
  step: ElicitStep,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<void> {
  const answered = client.request(methods.client.elicitation.create, elicitationRequest(step, sessionId)).then(
    (response) => {
      hooks.record("elicitation-answer", response);
    },
    (error: unknown) => {
      hooks.record("elicitation-error", { message: String(error) });
    },
  );
  if (step.detached === true) {
    state.detached.push(answered);
    return;
  }
  await answered;
}
```

Also update the `PromptState.detached` comment from `/** Detached permission requests and MCP calls of this prompt, settled when answered. */` to `/** Detached permission requests, MCP calls and elicitations of this prompt, settled when answered. */`, and in `script.ts` the `settled` step comment from `/** Waits until every detached permission request and MCP call of this prompt has been answered. */` to `/** Waits until every detached permission request, MCP call and elicitation of this prompt has been answered. */`.

Run (from `packages/nax-agent-acp`): `bun run typecheck`
Expected: exit 0 (the fixture is type-checked with the tests).

- [ ] **Step 2: Write the failing connection, inbound and open tests**

In `packages/nax-agent-acp/test/unit/client/connection.test.ts`:

Replace:

```ts
    { onUpdate: (n) => updates.push(n), onPermission: async (r) => rejectLocally(r), ...handlers },
```

with:

```ts
    {
      onUpdate: (n) => updates.push(n),
      onPermission: async (r) => rejectLocally(r),
      onElicitation: async () => ({ action: "cancel" }),
      ...handlers,
    },
```

Replace:

```ts
    const link = openConnection(agent.target, { onUpdate: () => {}, onPermission: async (r) => rejectLocally(r) });
```

with:

```ts
    const link = openConnection(agent.target, {
      onUpdate: () => {},
      onPermission: async (r) => rejectLocally(r),
      onElicitation: async () => ({ action: "cancel" }),
    });
```

Add after the test `"a permission request reaches onPermission and its answer reaches the agent"` (same `describe`):

```ts
  test("an elicitation reaches onElicitation and its answer reaches the agent (S4-5)", async () => {
    const seen: unknown[] = [];
    const { link, callsTo } = pair(
      { turns: [{ steps: [{ kind: "elicit", message: "Which env?" }] }] },
      {
        onElicitation: async (request) => {
          seen.push(request);
          return { action: "accept", content: { env: "staging" } };
        },
      },
    );
    await link.initialize(INIT);
    await link.newSession({ cwd: "/w", mcpServers: [] });
    await link.prompt({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "go" }] });
    expect(seen).toMatchObject([{ sessionId: "fake-session-1", mode: "form", message: "Which env?" }]);
    expect(callsTo("elicitation-answer")).toEqual([{ action: "accept", content: { env: "staging" } }]);
  });
```

In `packages/nax-agent-acp/test/unit/client/inbound.test.ts`:

Replace the first import block:

```ts
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { type AgentLogger, setAgentLogger } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, MAX_PENDING_DECISIONS, type PermissionDecider } from "#src/client/inbound";
```

with:

```ts
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { type AgentLogger, setAgentLogger, type TurnEvent } from "@nathapp/nax-agent";
import { createTurnCollector } from "#src/client/events";
import {
  createInboundRouter,
  type ElicitationHandler,
  MAX_PENDING_DECISIONS,
  type PermissionDecider,
} from "#src/client/inbound";
```

Append at the end of the file:

```ts
function elicitation(scope: { readonly sessionId: string } | { readonly requestId: string }): CreateElicitationRequest {
  return { ...scope, mode: "form", message: "Pick", requestedSchema: { type: "object", properties: {} } };
}

const ACCEPT: CreateElicitationResponse = { action: "accept", content: {} };
const CANCEL: CreateElicitationResponse = { action: "cancel" };

function recordingElicit(answer: (signal: AbortSignal) => Promise<CreateElicitationResponse> = async () => ACCEPT) {
  const seen: AbortSignal[] = [];
  const elicit: ElicitationHandler = (_request, signal) => {
    seen.push(signal);
    return answer(signal);
  };
  return { elicit, seen };
}

describe("createInboundRouter: elicitation (S4-5 D5-k)", () => {
  test("the bound session's elicitation reaches the handler with the binding signal", async () => {
    const { elicit, seen } = recordingElicit();
    const router = createInboundRouter(recordingDecider().decide, elicit);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(ACCEPT);
    expect(seen[0]).toBe(router.activeSignal());
    await release();
  });

  test("no turn, another session or request-scoped: cancel, the handler never runs, each reason logged once", async () => {
    const { logger, warnings } = recordingLogger();
    setAgentLogger(logger);
    const { elicit, seen } = recordingElicit();
    const router = createInboundRouter(recordingDecider().decide, elicit);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "b" }))).toEqual(CANCEL);
    expect(await router.handlers.onElicitation(elicitation({ requestId: "r-1" }))).toEqual(CANCEL);
    expect(seen).toEqual([]);
    expect(warnings).toEqual([
      { message: "Cancelled an elicitation locally", data: { reason: "no-turn" } },
      { message: "Cancelled an elicitation locally", data: { reason: "foreign-session" } },
    ]);
    await release();
  });

  test("permissions and elicitations share the pending cap", async () => {
    const { decide } = recordingDecider(untilAborted);
    const { elicit, seen } = recordingElicit();
    const router = createInboundRouter(decide, elicit);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const pending = Array.from({ length: MAX_PENDING_DECISIONS }, () => router.handlers.onPermission(request("a")));
    expect(await router.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    expect(seen).toEqual([]);
    await release();
    await Promise.all(pending);
  });

  test("release aborts a pending elicitation and waits for its answer", async () => {
    const state = { answered: false };
    const { elicit } = recordingElicit(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              state.answered = true;
              resolve(CANCEL);
            }, 20),
          );
        }),
    );
    const router = createInboundRouter(recordingDecider().decide, elicit);
    const release = router.attach("a", createTurnCollector(undefined), IDLE);
    const answer = router.handlers.onElicitation(elicitation({ sessionId: "a" }));
    await release();
    expect(state.answered).toBe(true);
    expect(await answer).toEqual(CANCEL);
  });

  test("a throwing handler, or no handler at all, answers cancel", async () => {
    const throwing = createInboundRouter(recordingDecider().decide, async () => {
      throw new Error("boom");
    });
    const releaseThrowing = throwing.attach("a", createTurnCollector(undefined), IDLE);
    expect(await throwing.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    await releaseThrowing();
    const bare = createInboundRouter(recordingDecider().decide);
    const releaseBare = bare.attach("a", createTurnCollector(undefined), IDLE);
    expect(await bare.handlers.onElicitation(elicitation({ sessionId: "a" }))).toEqual(CANCEL);
    await releaseBare();
  });
});

describe("createInboundRouter: a permission request announces its tool call (S4-5 D5-c)", () => {
  test("tool_call goes out before the decision; not for another session or after the abort", async () => {
    const events: TurnEvent[] = [];
    const router = createInboundRouter(recordingDecider().decide);
    const turn = new AbortController();
    const release = router.attach("a", createTurnCollector((e) => events.push(e)), turn.signal);
    await router.handlers.onPermission({ ...request("a"), toolCall: { toolCallId: "t1", title: "Run tests" } });
    await router.handlers.onPermission({ ...request("b"), toolCall: { toolCallId: "t2", title: "Other" } });
    turn.abort();
    await router.handlers.onPermission({ ...request("a"), toolCall: { toolCallId: "t3", title: "Late" } });
    expect(events).toEqual([{ type: "tool_call", callId: "t1", name: "Run tests", input: {} }]);
    await release();
  });
});
```

In `packages/nax-agent-acp/test/unit/client/open.test.ts`:

Replace:

```ts
import { openAcpSession } from "#src/client/open";
```

with:

```ts
import { clientCapabilitiesFor, openAcpSession } from "#src/client/open";
```

Replace:

```ts
    expect(fake.callsTo("initialize")).toEqual([{ protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }]);
```

with:

```ts
    // openContext's profile is "full": form elicitation is advertised (D5-l).
    expect(fake.callsTo("initialize")).toEqual([
      { protocolVersion: 1, clientCapabilities: { ...CLIENT_CAPABILITIES, elicitation: { form: {} } } },
    ]);
```

Add a new `describe` at the end of the file:

```ts
describe("clientCapabilitiesFor (S4-5 D5-l)", () => {
  test("form elicitation under ask and full only; never fs or terminal", () => {
    expect(clientCapabilitiesFor("ask")).toEqual({ elicitation: { form: {} } });
    expect(clientCapabilitiesFor("full")).toEqual({ elicitation: { form: {} } });
    expect(clientCapabilitiesFor("read")).toEqual({});
    expect(clientCapabilitiesFor("none")).toEqual({});
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/connection.test.ts test/unit/client/inbound.test.ts test/unit/client/open.test.ts`
Expected: FAIL: `onElicitation` is not a handler (the connection never registers `elicitation/create`, so the fake records `elicitation-error`), `createInboundRouter` takes no elicitation handler and announces nothing, `clientCapabilitiesFor` is not exported, and `initialize` sends `{}`.

- [ ] **Step 4: Replace `connection.ts`**

Replace `packages/nax-agent-acp/src/client/connection.ts` with:

```ts
/**
 * The ACP client connection (S4 spec §6.1 connection). One ClientApp per agent
 * process, attached with connect() for the session's lifetime (not connectWith).
 * Outbound calls use the connection's request API directly; inbound
 * session/update, session/request_permission and elicitation/create go to the
 * backend's handlers. Requests are not bounded here: callers race them (race.ts),
 * because the SDK's cancellation is cooperative and still waits for the agent's answer.
 */
import {
  type ClientConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  client,
  type InitializeRequest,
  type InitializeResponse,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { LaunchTarget } from "#src/client/launch";

export interface InboundHandlers {
  onUpdate(notification: SessionNotification): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export interface AcpLink {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /** Resolves when the connection closes, for any reason. */
  readonly closed: Promise<void>;
  /** Closes the connection; pending requests reject. */
  close(reason?: unknown): void;
}

export function openConnection(target: LaunchTarget, handlers: InboundHandlers): AcpLink {
  const app = client({ name: "nax-agent-acp" })
    .onNotification(methods.client.session.update, (ctx) => handlers.onUpdate(ctx.params))
    .onRequest(methods.client.session.requestPermission, (ctx) => handlers.onPermission(ctx.params))
    .onRequest(methods.client.elicitation.create, (ctx) => handlers.onElicitation(ctx.params));
  const connection: ClientConnection =
    target.kind === "stream" ? app.connect(target.stream) : app.connect(target.agent);
  const agent = connection.agent;
  return {
    initialize: (params) => agent.request(methods.agent.initialize, params),
    newSession: (params) => agent.request(methods.agent.session.new, params),
    setConfigOption: (params) => agent.request(methods.agent.session.setConfigOption, params),
    prompt: (params) => agent.request(methods.agent.session.prompt, params),
    cancel: (sessionId) => agent.notify(methods.agent.session.cancel, { sessionId }),
    closeSession: async (sessionId) => {
      await agent.request(methods.agent.session.close, { sessionId });
    },
    closed: connection.closed,
    close: (reason) => connection.close(reason),
  };
}
```

- [ ] **Step 5: Replace `inbound.ts`**

Replace `packages/nax-agent-acp/src/client/inbound.ts` with:

```ts
/**
 * Messages the agent initiates (S4 spec §6.3, §6.4, §6.8). While a turn runs the
 * router holds one binding: the agent session the turn prompts, its collector and
 * its signal. session/update reaches that collector only when it names the bound
 * session; anything else is dropped. session/request_permission and
 * elicitation/create for the bound session go to the backend's decider and
 * elicitation handler with the binding's signal, which aborts when the turn is
 * cancelled, times out or loses its process, and when the binding is released
 * (D3-d, D5-k). A permission request first announces its tool call on the turn's
 * events (D5-c). Any other request (no turn, another session, a request-scoped
 * elicitation, more than MAX_PENDING_DECISIONS pending at once) is answered locally,
 * a permission rejected and an elicitation cancelled, and raises no event; each
 * reason is logged once per session and kind (D3-c). Releasing a binding aborts its
 * pending requests and waits for their answers, so approval_resolved always
 * precedes turn_end.
 */
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { getLogger } from "@nathapp/nax-agent";
import type { InboundHandlers } from "#src/client/connection";
import type { TurnCollector } from "#src/client/events";
import { rejectLocally } from "#src/client/permissions";
import { isRecord } from "#src/client/text";

/** Concurrent permission requests and elicitations one turn may hold; further ones are answered locally. */
export const MAX_PENDING_DECISIONS = 16;

export type PermissionDecider = (
  request: RequestPermissionRequest,
  signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export type ElicitationHandler = (
  request: CreateElicitationRequest,
  signal: AbortSignal,
) => Promise<CreateElicitationResponse>;

export interface InboundRouter {
  readonly handlers: InboundHandlers;
  /**
   * Routes `agentSessionId`'s updates, permission requests and elicitations to this
   * turn. `turnSignal` aborts the turn's requests (cancel, timeout, process gone).
   * The returned function detaches the turn, aborts its pending requests and
   * resolves once each has been answered.
   */
  attach(agentSessionId: string, collector: TurnCollector, turnSignal: AbortSignal): () => Promise<void>;
  /**
   * The running turn's binding signal, or undefined between turns: what an
   * embedder tool call runs under (S4-4 D4-f). It aborts on cancel, timeout,
   * close and process exit, and when the binding is released.
   */
  activeSignal(): AbortSignal | undefined;
}

type Rejection = "no-turn" | "foreign-session" | "too-many";
type RequestKind = "permission" | "elicitation";

interface Binding {
  readonly sessionId: string;
  readonly collector: TurnCollector;
  readonly scope: AbortController;
  /** The scope and the turn signal: what every request of this turn is given. */
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<unknown>>;
}

const LOG_MESSAGES: Readonly<Record<RequestKind, string>> = {
  permission: "Rejected a permission request locally",
  elicitation: "Cancelled an elicitation locally",
};

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });
const CANCEL_ELICITATION: CreateElicitationResponse = { action: "cancel" };
const cancelElicitation = async (): Promise<CreateElicitationResponse> => CANCEL_ELICITATION;

async function track<T>(binding: Binding, answer: Promise<T>): Promise<T> {
  binding.pending.add(answer);
  try {
    return await answer;
  } finally {
    binding.pending.delete(answer);
  }
}

/** The session an elicitation names; undefined for a request-scoped one. */
function sessionOf(request: unknown): string | undefined {
  return isRecord(request) && typeof request.sessionId === "string" ? request.sessionId : undefined;
}

export function createInboundRouter(
  decide: PermissionDecider,
  elicit: ElicitationHandler = cancelElicitation,
): InboundRouter {
  let active: Binding | undefined;
  const logged = new Set<string>();
  const log = (kind: RequestKind, reason: Rejection): void => {
    const key = `${kind}:${reason}`;
    if (logged.has(key)) return;
    logged.add(key);
    try {
      getLogger().warn("acp", LOG_MESSAGES[kind], { reason });
    } catch {
      // A throwing host logger must not change the answer.
    }
  };
  /** The binding a request may use, or why not. */
  const admit = (sessionId: string | undefined): Binding | Rejection => {
    const binding = active;
    if (binding === undefined) return "no-turn";
    if (sessionId !== binding.sessionId) return "foreign-session";
    return binding.pending.size >= MAX_PENDING_DECISIONS ? "too-many" : binding;
  };
  /** A request refused while the turn is being aborted is answered as cancelled, not rejected (S4-3). */
  const aborting = (reason: Rejection): boolean => reason !== "no-turn" && active?.signal.aborted === true;
  return {
    handlers: {
      onUpdate(notification) {
        if (active !== undefined && notification.sessionId === active.sessionId) {
          active.collector.onUpdate(notification.update);
        }
      },
      onPermission: async (request) => {
        const admitted = admit(request.sessionId);
        if (typeof admitted === "string") {
          if (aborting(admitted)) return cancelled();
          log("permission", admitted);
          return rejectLocally(request);
        }
        if (!admitted.signal.aborted) admitted.collector.announce(request.toolCall);
        return track(admitted, decide(request, admitted.signal).catch(cancelled));
      },
      onElicitation: async (request) => {
        const admitted = admit(sessionOf(request));
        if (typeof admitted === "string") {
          if (!aborting(admitted)) log("elicitation", admitted);
          return CANCEL_ELICITATION;
        }
        return track(admitted, elicit(request, admitted.signal).catch(cancelElicitation));
      },
    },
    activeSignal: () => active?.signal,
    attach(sessionId, collector, turnSignal) {
      const scope = new AbortController();
      const binding: Binding = {
        sessionId,
        collector,
        scope,
        signal: AbortSignal.any([scope.signal, turnSignal]),
        pending: new Set(),
      };
      active = binding;
      return async () => {
        if (active === binding) active = undefined;
        scope.abort();
        await Promise.allSettled([...binding.pending]);
      };
    },
  };
}
```

- [ ] **Step 6: `open.ts`: client capabilities by profile**

In `packages/nax-agent-acp/src/client/open.ts`:

Replace the header comment's first sentence:

```ts
 * Opening an ACP session (S4 spec §6.3 step 1): spawn, initialize, capability
```

with:

```ts
 * Opening an ACP session (S4 spec §6.3 step 1): spawn, initialize (form
 * elicitation advertised under ask and full, S4-5 D5-l), capability
```

Replace:

```ts
import { type McpServer, PROTOCOL_VERSION, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
```

with:

```ts
import {
  type ClientCapabilities,
  type McpServer,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { type AgentSessionProfile, type BackendOpenContext, NaxError, type TranscriptDoc } from "@nathapp/nax-agent";
```

Replace:

```ts
    o.link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
```

with:

```ts
    o.link.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: clientCapabilitiesFor(o.ctx.profile) }),
```

Add before `async function establish`:

```ts
/** §6.3 step 1.1: no fs and no terminal (R11); form elicitation under ask and full (§6.8, D5-l). */
export function clientCapabilitiesFor(profile: AgentSessionProfile): ClientCapabilities {
  return profile === "ask" || profile === "full" ? { elicitation: { form: {} } } : {};
}
```

- [ ] **Step 7: Replace `backend.ts`**

Replace `packages/nax-agent-acp/src/client/backend.ts` with:

```ts
/**
 * acpBackend(): nax-agent's SessionBackend over ACP (S4 spec §6). It serves all
 * four profiles: the agent's mode is set at open (§6.4 layer 1), and each
 * session/request_permission is decided by profile (layer 2, permissions.ts),
 * through the caller under `ask`. Embedder tools are served by a per-session MCP
 * tool host (§6.6, tool-host.ts) and pre-approved at the adapter (R12); the
 * host's token joins the session's redaction set before the agent starts (D4-i).
 * The agent's updates become turn events with per-turn usage priced by one cost
 * meter per session (§6.7, events.ts, usage.ts), and its form elicitations become
 * questions under `ask` and `full` (§6.8, elicitation.ts). A turn's permission
 * decisions, questions and tool calls are cancelled when the turn is cancelled,
 * times out, ends or loses its process (D3-d, D4-f, D5-j). Until its stage lands
 * it refuses resume (S4-6) before spawning anything. A crashed or killed agent
 * leaves the session disconnected; reconnect is S4-6, so until then later turns
 * end AGENT_SESSION_CLOSED (D-f).
 */
import {
  type AgentSessionAdapter,
  AgentSessionError,
  type BackendOpenContext,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionHandle,
  type TranscriptStore,
  type TurnResult,
} from "@nathapp/nax-agent";
import { answerElicitation } from "#src/client/elicitation";
import { capabilityUnsupported } from "#src/client/errors";
import { createTurnCollector } from "#src/client/events";
import { createInboundRouter, type InboundRouter } from "#src/client/inbound";
import { type LaunchFn, launchAgent } from "#src/client/launch";
import { type OpenedAcp, openAcpSession } from "#src/client/open";
import { type AcpBackendOptions, type ResolvedAcpOptions, resolveAcpOptions } from "#src/client/options";
import { decidePermission } from "#src/client/permissions";
import { race } from "#src/client/race";
import { createToolCalls } from "#src/client/tool-calls";
import { createToolHost, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { runPromptTurn, type TurnState } from "#src/client/turn";
import { type CostMeter, createCostMeter } from "#src/client/usage";

/** Test seam: the process launcher. Production always uses launchAgent. */
export const _acpBackendDeps: { launch: LaunchFn } = { launch: launchAgent };

interface SessionFlags {
  disconnected: boolean;
  closing: Promise<void> | undefined;
  instructionsSent: boolean;
}

interface Live {
  readonly options: ResolvedAcpOptions;
  readonly ctx: BackendOpenContext;
  readonly acp: OpenedAcp;
  readonly router: InboundRouter;
  readonly flags: SessionFlags;
  readonly state: TurnState;
  /** Aborted when the agent process exits: the running turn's permission decisions settle cancelled (§6.3 step 5). */
  readonly gone: AbortController;
  /** The embedder tools' MCP host; undefined when the session has no tools. */
  readonly host: ToolHost | undefined;
  /** The agent process's cumulative cost readings, one meter per process (D5-b). */
  readonly meter: CostMeter;
}

export function acpBackend(input: AcpBackendOptions): SessionBackend {
  const options = resolveAcpOptions(input);
  return Object.freeze({ kind: options.kind, open: (ctx: BackendOpenContext) => openBackend(options, ctx) });
}

function refuseUnbuilt(ctx: BackendOpenContext): void {
  if (ctx.resume !== undefined) throw capabilityUnsupported("resume", "resuming an ACP session arrives in S4-6");
}

/** The session's options: the tool host's token joins the redaction set (D4-i). */
function withToken(options: ResolvedAcpOptions, token: string | undefined): ResolvedAcpOptions {
  if (token === undefined) return options;
  return Object.freeze({ ...options, secrets: Object.freeze([...options.secrets, token]) });
}

function toolHostFor(
  ctx: BackendOpenContext,
  router: InboundRouter,
  secrets: readonly string[],
  token: string | undefined,
): ToolHost | undefined {
  if (token === undefined) return undefined;
  const calls = createToolCalls({
    sessionId: ctx.sessionId,
    tools: ctx.tools,
    asks: ctx.asks,
    currentTurnId: ctx.currentTurnId,
    turnSignal: () => router.activeSignal(),
    secrets,
  });
  return createToolHost(calls, token);
}

/** Permission requests and elicitations, decided by profile with the session's redaction set. */
function routerFor(ctx: BackendOpenContext, secrets: readonly string[]): InboundRouter {
  const base = { profile: ctx.profile, asks: ctx.asks, secrets };
  return createInboundRouter(
    (request, signal) => decidePermission(request, { ...base, signal }),
    (request, signal) => answerElicitation(request, { ...base, signal }),
  );
}

async function openBackend(base: ResolvedAcpOptions, ctx: BackendOpenContext): Promise<OpenedBackend> {
  refuseUnbuilt(ctx);
  const token = ctx.tools.length > 0 ? newToolHostToken() : undefined;
  const options = withToken(base, token);
  const gone = new AbortController();
  const router = routerFor(ctx, options.secrets);
  const host = toolHostFor(ctx, router, options.secrets, token);
  const acp = await openAcpSession(options, ctx, router.handlers, _acpBackendDeps.launch, host).catch(
    async (err: unknown) => {
      await host?.stop();
      throw err;
    },
  );
  const flags: SessionFlags = { disconnected: false, closing: undefined, instructionsSent: false };
  void acp.launched.exited.then(() => {
    flags.disconnected = true;
    gone.abort();
  });
  const state: TurnState = {
    link: acp.link,
    launched: acp.launched,
    agentSessionId: acp.agentSessionId,
    cancelGraceMs: options.cancelGraceMs,
    secrets: options.secrets,
    disconnect: () => {
      flags.disconnected = true;
    },
  };
  return assemble({ options, ctx, acp, router, flags, state, gone, host, meter: createCostMeter() });
}

function assemble(live: Live): OpenedBackend {
  const handle: SessionHandle = Object.freeze({ id: live.ctx.sessionId, agentName: live.options.kind });
  const adapter: AgentSessionAdapter = {
    openSession: async () => handle,
    sendTurn: (_handle, prompt, opts) => sendTurn(live, prompt, opts),
    // The agent session closes in OpenedBackend.close(), within the §6.3 step 4 bound (D-j).
    closeSession: async () => {},
  };
  return {
    adapter,
    handle,
    info: Object.freeze({ kind: live.options.kind, capabilities: live.acp.record }),
    turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
    close: () => {
      live.flags.closing ??= shutdown(live);
      return live.flags.closing;
    },
  };
}

async function sendTurn(live: Live, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  const { ctx, flags } = live;
  if (flags.disconnected || flags.closing !== undefined) {
    throw new AgentSessionError(
      `ACP session "${ctx.sessionId}" has lost its agent process; reconnect arrives in S4-6`,
      "AGENT_SESSION_CLOSED",
      { sessionId: ctx.sessionId },
    );
  }
  const instructions = flags.instructionsSent ? undefined : ctx.instructions;
  flags.instructionsSent = true;
  const text = instructions === undefined || instructions === "" ? prompt : `${instructions}\n\n${prompt}`;
  const collector = createTurnCollector(opts.onTurnEvent, { secrets: live.options.secrets, meter: live.meter });
  const signal = opts.signal ?? ctx.turnSignal();
  const release = live.router.attach(live.acp.agentSessionId, collector, AbortSignal.any([signal, live.gone.signal]));
  try {
    return await runPromptTurn(live.state, { text, signal, collector });
  } finally {
    await release();
    // The release aborted this turn's tool calls; wait for their answers (D4-f).
    await live.host?.drain();
    // Held text and calls left without a result go out before turn_end (D5-e, D5-g).
    collector.finish();
  }
}

async function shutdown(live: Live): Promise<void> {
  const { acp, options, flags } = live;
  if (!flags.disconnected && acp.record.close) {
    await race(acp.link.closeSession(acp.agentSessionId), { timeoutMs: options.cancelGraceMs });
  }
  await acp.launched.terminate(options.cancelGraceMs);
  acp.link.close();
  // §6.3 close step 4: stop the tool host and revoke its token.
  await live.host?.stop();
  await saveFinal(live.ctx.transcriptStore, live.ctx.sessionId);
}

/** §6.3 step 4.5: the document with its final savedAt. Load-merge keeps the facade's turn marker. */
async function saveFinal(store: TranscriptStore, sessionId: string): Promise<void> {
  const doc = await store.load(sessionId);
  if (doc !== null) await store.save(sessionId, { ...doc, savedAt: new Date().toISOString() });
}
```

- [ ] **Step 8: Run the unit tests**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/connection.test.ts test/unit/client/inbound.test.ts test/unit/client/open.test.ts`
Expected: PASS, every existing test included (the permission log messages and reasons are unchanged).

- [ ] **Step 9: Update the permission sequence for the announced tool call**

A permission request now announces its tool call, and the fake never completes it, so the turn answers it as not answered. In `packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts` replace:

```ts
    expect(types(events)).toEqual([
      "turn_start",
      "approval_requested",
      "approval_resolved",
      "text_delta",
      "usage",
      "turn_end",
    ]);
```

with:

```ts
    expect(types(events)).toEqual([
      "turn_start",
      "tool_call",
      "approval_requested",
      "approval_resolved",
      "text_delta",
      "tool_result",
      "usage",
      "turn_end",
    ]);
    expect(find(events, "tool_call")).toMatchObject({ callId: "fake-permission", name: "Edit a file" });
```

(The foreign-session sequence `["turn_start", "text_delta", "usage", "turn_end"]` is unchanged: a request for another session announces nothing.)

- [ ] **Step 10: Run the package suite**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 11: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/src/client/connection.ts packages/nax-agent-acp/src/client/inbound.ts packages/nax-agent-acp/src/client/open.ts packages/nax-agent-acp/src/client/backend.ts packages/nax-agent-acp/test/fixtures/fake-agent/script.ts packages/nax-agent-acp/test/fixtures/fake-agent/agent.ts packages/nax-agent-acp/test/unit/client/connection.test.ts packages/nax-agent-acp/test/unit/client/inbound.test.ts packages/nax-agent-acp/test/unit/client/open.test.ts packages/nax-agent-acp/test/unit/client/backend-permissions.test.ts
git commit -m "feat(nax-agent-acp): route elicitations, announce permission tool calls, advertise form elicitation"
```

---
### Task 7: End to end in process: events, usage, scrubbing, elicitation

**Files:**
- Create: `packages/nax-agent-acp/test/unit/client/backend-events.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 0 to 6 through `acpBackend()` and the facade; the fake agent's `update`, `elicit` and `text.echoMcpAuth` steps (Task 6).

- [ ] **Step 1: Write the tests**

Create `packages/nax-agent-acp/test/unit/client/backend-events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ElicitationSchema, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  type AgentSessionProfile,
  type AnswerStatus,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { UNANSWERED_PREVIEW } from "#src/client/tool-events";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep, type FakeTurn } from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const SECRET = "s3cr3t-token-value-0123";
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-events-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

interface OpenOptions {
  readonly profile?: AgentSessionProfile;
  readonly backend?: Partial<AcpBackendOptions>;
  readonly script?: FakeScript;
  readonly tools?: readonly EmbedderTool[];
}

async function open(turns: readonly FakeTurn[], o: OpenOptions = {}): Promise<Opened> {
  const fake = inMemoryAgent({
    agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
    configOptions: CLAUDE_CONFIG_OPTIONS,
    turns,
    ...o.script,
  });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude", ...o.backend }),
    profile: o.profile ?? "full",
    workdir,
    tools: o.tools ?? [],
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

const update = (u: SessionUpdate): FakeStep => ({ kind: "update", update: u });
const usd = (amount: number): FakeStep =>
  update({ sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount, currency: "USD" } });
const types = (events: readonly SessionEvent[]) => events.map((e) => e.type);
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const texts = (events: readonly SessionEvent[], type: "text_delta" | "thinking_delta") =>
  events.flatMap((e) => (e.type === type ? [e.text] : []));

describe("tool calls and usage end to end (spec §6.7; D5-a to D5-f, D5-h)", () => {
  test("a tool call, its result, a thought, text and the turn's usage", async () => {
    const o = await open([
      {
        steps: [
          update({ sessionUpdate: "tool_call", toolCallId: "toolu_1", name: "Read", title: "Read", kind: "read", status: "pending", rawInput: {} }),
          update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_1", rawInput: { file_path: "/w/a.ts" } }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "export {}" } }],
          }),
          { kind: "thought", text: "read it" },
          { kind: "text", text: "All good" },
          usd(0.01),
        ],
        usage: { totalTokens: 175, inputTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 50 },
      },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(types(events)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "thinking_delta",
      "text_delta",
      "usage",
      "turn_end",
    ]);
    expect(find(events, "tool_call")).toMatchObject({ callId: "toolu_1", name: "Read", input: { file_path: "/w/a.ts" } });
    expect(find(events, "tool_result")).toMatchObject({ callId: "toolu_1", isError: false, preview: "export {}" });
    expect(find(events, "usage")).toMatchObject({
      round: 0,
      inputTokens: 100,
      outputTokens: 25,
      cacheRead: 50,
      costUsd: 0.01,
      costSource: "reported",
    });
    expect(endOf(events)).toMatchObject({
      status: "completed",
      output: "All good",
      usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 50 },
      costUsd: 0.01,
      costSource: "reported",
    });
  });

  test("turn 2 reports its own tokens and the cost difference (Review Focus 4)", async () => {
    const o = await open([
      { steps: [usd(0.01)], usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } },
      { steps: [usd(0.025)], usage: { totalTokens: 7, inputTokens: 5, outputTokens: 2 } },
    ]);
    expect(find(await driveTurn(o.session, "one"), "usage")).toMatchObject({ inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
    const second = find(await driveTurn(o.session, "two"), "usage");
    expect(second).toMatchObject({ inputTokens: 5, outputTokens: 2, costSource: "reported" });
    expect(second?.type === "usage" ? second.costUsd : -1).toBeCloseTo(0.015, 10);
  });

  test("a turn with no cost is unpriced; the next priced turn carries the spend in between", async () => {
    const o = await open([{ steps: [usd(0.01)] }, { steps: [{ kind: "text", text: "x" }] }, { steps: [usd(0.04)] }]);
    await driveTurn(o.session, "one");
    expect(find(await driveTurn(o.session, "two"), "usage")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costSource: "unpriced",
    });
    const third = find(await driveTurn(o.session, "three"), "usage");
    expect(third?.type === "usage" ? third.costUsd : -1).toBeCloseTo(0.03, 10);
  });

  test("a stop reason other than end_turn still emits its usage event; turn_end usage stays zero (D5-h)", async () => {
    const o = await open([
      { steps: [{ kind: "text", text: "x" }], stopReason: "max_tokens", usage: { totalTokens: 9, inputTokens: 4, outputTokens: 5 } },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(find(events, "usage")).toMatchObject({ inputTokens: 4, outputTokens: 5 });
    expect(endOf(events)).toMatchObject({
      status: "errored",
      error: { code: "ACP_STOP_MAX_TOKENS" },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  test("a call still running at turn end is answered not answered, before the usage event", async () => {
    const o = await open([
      {
        steps: [
          update({ sessionUpdate: "tool_call", toolCallId: "toolu_2", name: "Bash", status: "in_progress", rawInput: { command: "sleep 9" } }),
          { kind: "text", text: "giving up" },
        ],
      },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(types(events)).toEqual(["turn_start", "tool_call", "text_delta", "tool_result", "usage", "turn_end"]);
    expect(find(events, "tool_result")).toMatchObject({ callId: "toolu_2", isError: true, preview: UNANSWERED_PREVIEW });
  });

  test("a cancelled turn answers its running call and emits no usage event", async () => {
    const o = await open([
      {
        steps: [
          update({ sessionUpdate: "tool_call", toolCallId: "toolu_3", name: "Bash", status: "in_progress" }),
          { kind: "waitForCancel" },
        ],
      },
    ]);
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "tool_call") o.session.cancel();
    });
    expect(endOf(events).status).toBe("cancelled");
    expect(find(events, "tool_result")).toMatchObject({ callId: "toolu_3", isError: true });
    expect(find(events, "usage")).toBeUndefined();
  });
});

describe("agent text is scrubbed of the session's secrets (D5-g, Review Focus 1)", () => {
  test("an env secret split across text chunks, and one in a thought", async () => {
    const o = await open(
      [
        {
          steps: [
            { kind: "text", text: "key s3cr3t-tok" },
            { kind: "text", text: "en-value-0123 ok" },
            { kind: "thought", text: `t ${SECRET}` },
          ],
        },
      ],
      { backend: { env: { MY_TOKEN: SECRET } } },
    );
    const events = await driveTurn(o.session, "go");
    expect(texts(events, "text_delta").join("")).toBe("key [REDACTED] ok");
    expect(texts(events, "text_delta").some((t) => t.includes("s3cr3t") || t.includes("value-0123"))).toBe(false);
    expect(texts(events, "thinking_delta").join("")).toBe("t [REDACTED]");
    expect(endOf(events).output).toBe("key [REDACTED] ok");
  });

  test("the tool host's token echoed by the agent is scrubbed from text and output", async () => {
    const lookup: EmbedderTool = {
      name: "lookup",
      description: "Look a word up",
      inputSchema: { type: "object" },
      approval: "never",
      run: async () => ({ content: "found" }),
    };
    const o = await open([{ steps: [{ kind: "text", text: "auth=", echoMcpAuth: true }] }], {
      tools: [lookup],
      script: { capabilities: { mcpCapabilities: { http: true } } },
    });
    const events = await driveTurn(o.session, "go");
    expect(texts(events, "text_delta").join("")).toBe("auth=Bearer [REDACTED]");
    expect(endOf(events).output).toBe("auth=Bearer [REDACTED]");
  });
});

/** Claude's AskUserQuestion with one question: a titled oneOf plus its "Other" companion. */
const AUTH_FORM: ElicitationSchema = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Auth",
      oneOf: [
        { const: "OAuth", title: "OAuth" },
        { const: "API key", title: "API key" },
      ],
    },
    question_0_custom: { type: "string", title: "Other" },
  },
};
const ASK_AUTH: FakeStep = { kind: "elicit", message: "Which auth?", requestedSchema: AUTH_FORM };

describe("elicitation end to end (spec §6.8; D5-i to D5-l, Review Focus 2 and 3)", () => {
  test.each(["ask", "full"] as const)("under %s: a question round trip; the agent gets the form content", async (profile) => {
    const o = await open([{ steps: [ASK_AUTH, { kind: "text", text: "ok" }] }], { profile });
    const statuses: AnswerStatus[] = [];
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "question") statuses.push(o.session.answer(event.requestId, { text: "2" }));
    });
    expect(statuses).toEqual(["accepted"]);
    const question = find(events, "question");
    expect(question?.type === "question" ? question.text : "").toContain("2. API key");
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "accept", content: { question_0: "API key" } }]);
    expect(endOf(events).status).toBe("completed");
  });

  test("a free-text reply becomes Claude's 'Other' answer", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "ask" });
    await driveTurn(o.session, "go", (event) => {
      if (event.type === "question") o.session.answer(event.requestId, { text: "mTLS" });
    });
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "accept", content: { question_0_custom: "mTLS" } }]);
  });

  test("under read: elicitation is not advertised, and a stray one is declined unasked", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "read" });
    const events = await driveTurn(o.session, "go");
    expect(JSON.stringify(o.fake.callsTo("initialize"))).not.toContain("elicitation");
    expect(find(events, "question")).toBeUndefined();
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "decline" }]);
  });

  test("a request-scoped elicitation is cancelled with no event", async () => {
    const o = await open([{ steps: [{ ...ASK_AUTH, scope: "request" }] }], { profile: "ask" });
    const events = await driveTurn(o.session, "go");
    expect(find(events, "question")).toBeUndefined();
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "cancel" }]);
  });

  test("cancel during a question: it settles cancelled and the agent's form is cancelled", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "ask" });
    let questionId = "";
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "question") {
        questionId = event.requestId;
        o.session.cancel();
      }
    });
    expect(endOf(events).status).toBe("cancelled");
    expect(o.session.answer(questionId, { text: "late" })).toBe("cancelled");
    await waitForCondition(() => o.fake.callsTo("elicitation-answer").length > 0, 2_000);
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "cancel" }]);
  });

  test("the agent process dies during a question: it settles cancelled at once (D5-j)", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "ask" });
    let questionId = "";
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "question") {
        questionId = event.requestId;
        o.fake.crash();
      }
    });
    expect(endOf(events).status).toBe("errored");
    expect(o.session.answer(questionId, { text: "late" })).toBe("cancelled");
  });

  test("a permission request's tool call and its approval come in that order (D5-c)", async () => {
    const o = await open(
      [
        {
          steps: [
            {
              kind: "permission",
              options: ["allow_once", "reject_once"],
              toolCall: { toolCallId: "toolu_9", title: "Run tests", kind: "execute", rawInput: { command: "bun test" } },
            },
            update({
              sessionUpdate: "tool_call_update",
              toolCallId: "toolu_9",
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "3 pass" } }],
            }),
          ],
        },
      ],
      { profile: "ask" },
    );
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "allow" });
    });
    expect(types(events)).toEqual([
      "turn_start",
      "tool_call",
      "approval_requested",
      "approval_resolved",
      "tool_result",
      "usage",
      "turn_end",
    ]);
    expect(find(events, "approval_requested")).toMatchObject({ callId: "toolu_9" });
    expect(find(events, "tool_result")).toMatchObject({ callId: "toolu_9", isError: false, preview: "3 pass" });
  });
});
```

- [ ] **Step 2: Run them**

Run (from `packages/nax-agent-acp`): `bun test test/unit/client/backend-events.test.ts`
Expected: PASS. If the crash test reports `"accepted"`, Task 0 is missing from the branch: the question did not take the binding's signal.

- [ ] **Step 3: Confirm the crash test proves D5-j**

Temporarily change the `ask` helper in `src/client/elicitation.ts` to call `ctx.asks.askQuestion(shown(text, ctx.secrets))` (no options), and run `bun test test/unit/client/backend-events.test.ts -t "dies during a question"`.
Expected: FAIL (`"accepted"`, or the turn never ends and the test times out). Restore the `{ signal: ctx.signal }` argument and re-run: PASS. Do not commit the temporary change.

- [ ] **Step 4: Lint, typecheck, coverage, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all && bun run test:coverage`
Expected: exit 0; `stream-scrub.ts`, `usage.ts`, `tool-events.ts`, `elicitation.ts`, `events.ts` each at or above 80%, and the per-file baseline stays empty.

```bash
git add packages/nax-agent-acp/test/unit/client/backend-events.test.ts
git commit -m "test(nax-agent-acp): events, usage, scrubbing and elicitation end to end"
```

---

### Task 8: Usage and a question over a real Node agent process

**Files:**
- Modify: `packages/nax-agent-acp/test/node/acp-backend.test.ts` (append one test)

**Interfaces:**
- Consumes: the fake agent's `update` and `elicit` steps (Task 6); `FAKE_MAIN`, `fakeEnv`, `readRecords` (`test/helpers/fake-process.ts`); `CLAUDE_CONFIG_OPTIONS` (already imported).

- [ ] **Step 1: Write the test**

Append to `packages/nax-agent-acp/test/node/acp-backend.test.ts`:

```ts
test("tool events, usage and a question round trip over a Node agent process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-events-"));
  dirs.push(workdir);
  const record = join(workdir, "record.jsonl");
  const session = await createAgentSession({
    backend: acpBackend({
      agent: "claude",
      allowUnsandboxed: true,
      command: process.execPath,
      args: [FAKE_MAIN],
      env: fakeEnv(
        {
          configOptions: CLAUDE_CONFIG_OPTIONS,
          turns: [
            {
              steps: [
                {
                  kind: "update",
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: "t1",
                    name: "Read",
                    status: "completed",
                    rawInput: { file_path: "a.ts" },
                    content: [{ type: "content", content: { type: "text", text: "body" } }],
                  },
                },
                {
                  kind: "elicit",
                  message: "Which env?",
                  requestedSchema: { type: "object", properties: { env: { type: "string", enum: ["staging", "prod"] } } },
                },
                {
                  kind: "update",
                  update: { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.01, currency: "USD" } },
                },
              ],
              usage: { totalTokens: 3, inputTokens: 1, outputTokens: 2 },
            },
          ],
        },
        record,
      ),
    }),
    profile: "ask",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("go")) {
    events.push(event);
    if (event.type === "question") session.answer(event.requestId, { text: "prod" });
  }
  expect(events.map((e) => e.type)).toEqual(["turn_start", "tool_call", "tool_result", "question", "usage", "turn_end"]);
  expect(events.find((e) => e.type === "usage")).toMatchObject({
    inputTokens: 1,
    outputTokens: 2,
    costUsd: 0.01,
    costSource: "reported",
  });
  expect(readRecords(record).filter((r) => r.method === "elicitation-answer")).toMatchObject([
    { params: { action: "accept", content: { env: "prod" } } },
  ]);
  await session.close();
});
```

- [ ] **Step 2: Run it on Node**

Run (from `packages/nax-agent-acp`): `bun run test:node`
Expected: PASS, every test (the new one included) under Node 22+.

- [ ] **Step 3: Lint, typecheck, commit**

Run: `bun run lint:fix && bun run typecheck && bun run check:all`
Expected: exit 0.

```bash
git add packages/nax-agent-acp/test/node/acp-backend.test.ts
git commit -m "test(nax-agent-acp): tool events, usage and a question over a Node agent process"
```

---

### Task 9: Docs, context and the spec amendments

**Files:**
- Modify: `packages/nax-agent-acp/src/client/index.ts` (header comment)
- Modify: `packages/nax-agent-acp/README.md`
- Modify: `packages/nax-agent-acp/CHANGELOG.md`
- Modify: `.nax/mono/packages/nax-agent-acp/context.md` (repo root)
- Modify: `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md` (R9, §5.1, §6.6, §6.7, §6.8, §11.2, §12)
- Regenerated: `packages/nax-agent-acp/CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `codex.md`

**Interfaces:** none.

- [ ] **Step 1: `index.ts` header**

Replace the header comment of `packages/nax-agent-acp/src/client/index.ts` with:

```ts
/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * S4-5 serves sessions under all four profiles: permission requests decided by
 * profile (approved through answer() under `ask`), embedder tools through a
 * per-session loopback MCP tool host that Claude's adapter pre-approves, thinking,
 * tool and usage events, and the agent's form elicitations as questions. Resume
 * (S4-6) is refused with AGENT_SESSION_CAPABILITY_UNSUPPORTED until its stage
 * lands. Nothing is released before S4-6.
 */
```

- [ ] **Step 2: README**

In `packages/nax-agent-acp/README.md`, replace the status paragraph:

```md
**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves text sessions under all four profiles,
and embedder tools on Claude. Tool and usage events (S4-5) and resume (S4-6) are
refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until their stage lands.
`./server` is reserved for a later ACP server.
```

with:

```md
**Status: pre-release.** The package is built in stages (S4-1 to S4-6) and is not
published yet. Today `acpBackend()` serves sessions under all four profiles, with
thinking, tool and usage events, questions from the agent, and embedder tools on
Claude. Resume (S4-6) is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until
its stage lands. `./server` is reserved for a later ACP server.
```

Replace:

```md
- **Usage** is reported as zeros with `costSource: "unpriced"`. Never sum
  `unpriced` rows as a cost.
```

with:

```md
- **Usage.** Each turn ends with one `usage` event: the tokens the agent reports for
  the turn, and the cost it reports (`costSource: "reported"`). An agent that reports
  no cost gives `costUsd: 0` with `costSource: "unpriced"`. Never sum `unpriced`
  rows as a cost. See "Events and usage on ACP".
```

Replace:

```md
- **Where the token is redacted.** Errors, the agent's stderr, approval displays
  and tool summaries, and it is never stored in the transcript. Text the agent
  writes itself is passed through as written.
```

with:

```md
- **Where the token is redacted.** Errors, the agent's stderr, approval displays,
  tool summaries, tool events, and the agent's own text and thinking. It is never
  stored in the transcript.
```

Append at the end of the file:

```md
## Events and usage on ACP

A turn on ACP emits the same event types as on the native backend, with these
differences.

- **Text and thinking** arrive as `text_delta` and `thinking_delta`, always with
  `round: 0`. `stream_reset` and `compaction` never occur.
- **Your secrets are scrubbed from the agent's text.** The values of `env` keys
  named like `KEY`, `TOKEN`, `SECRET` or `PASSWORD` (8 characters or more) and the
  tool host's token show as `[REDACTED]` in `text_delta`, `thinking_delta` and
  `turn_end.output`, also when a value arrives split across two chunks. To catch
  that, up to one such value's length of text is held back until the next chunk;
  without such values nothing is held. Other secrets are not pattern-redacted in
  text, as on the native backend.
- **Tool calls.** `tool_call` is sent when the agent uses the call: it asks
  permission for it, reports progress, or finishes. It is not sent when the call is
  first mentioned, because Claude fills in a call's input after mentioning it.
  `name` is the agent's tool name (with Claude: `Read`, `Bash`, `mcp__nax__<tool>`).
  Every `tool_call` is followed by exactly one `tool_result`. A call still running
  when the turn ends gets `isError: true` and `"Not answered: the turn ended."`. A
  call the agent mentions but never uses produces no events.
- **Inputs and previews** are capped and redacted best-effort, as on the native
  backend. A file edit shows as `edit <path> (+added -removed)` lines.
- **Usage.** One `usage` event per turn, after the turn's last delta and tool
  result, also when the turn stops for a reason other than `end_turn`.
  - Tokens are the agent's numbers for the turn. Output tokens include thinking
    tokens. Cache fields appear only when the agent reports them.
  - Cost: the agent reports a running total for the session, and each turn's cost
    is the difference. Spend between turns, or in a turn that ends without the
    agent's final answer (cancel, crash), is counted in the next turn that reports
    a cost.
  - A turn that ends `errored` has zero `usage` in `turn_end`; read its `usage`
    event instead.

## Questions from the agent

Under `ask` and `full` this client tells the agent it can show forms. Claude uses
forms for its AskUserQuestion tool and for some model-fallback prompts. Under `none`
and `read` forms are not offered, and one that arrives anyway is declined.

- **Each form field is one `question` event.** Answer it with
  `answer(requestId, { text })`.
  - Choices are numbered. Reply with a number or the choice's text, in any case.
  - A multi-select takes a comma-separated list.
  - Claude's "Other" box: a reply that is not one of the choices becomes your own
    answer.
  - An empty reply skips an optional field.
- **Declined forms.** Forms with number, boolean or other field types, more than 16
  fields or more than 32 choices, and requests to open a URL are declined. You see
  an informational `question` that starts with `declined:`; `answer()` on it
  returns `"cancelled"`. A reply that matches no choice (when there is no "Other"
  box) and an empty reply to a required field also decline the form, with a note.
- **No answer cancels.** An unanswered question after `approvalTimeoutMs`, a
  cancelled turn, the turn ending or the agent process dying cancels the whole form,
  and later fields are not asked. `answer()` on that question returns `"cancelled"`.
- **Question text comes from the agent.** Control characters are stripped, your
  secrets scrubbed, and it is capped at 4 KiB.
```

- [ ] **Step 3: CHANGELOG**

In `packages/nax-agent-acp/CHANGELOG.md`, append to the `## [Unreleased]` list:

```md
- Turn events, usage and questions on `acpBackend()` (S4-5). Agent thoughts become
  `thinking_delta`. Tool calls become `tool_call` / `tool_result`: sent when the
  call is used, one result per call, calls still running at turn end closed as not
  answered. Each turn ends with one `usage` event with the agent's per-turn tokens
  and the turn's share of its cumulative reported cost (`costSource: "reported"`,
  else `"unpriced"`). Session secret values, the tool host's token included, are
  scrubbed from agent text, thinking and `turn_end.output`, also when split across
  chunks. Form elicitations become `question` events under `ask` and `full`, one per
  field (single- and multi-select, free text, Claude's "Other" box); other forms are
  declined, and an unanswered or abandoned form is cancelled. Needs nax-agent's
  `askQuestion(text, { signal })`.
```

- [ ] **Step 4: context**

In `.nax/mono/packages/nax-agent-acp/context.md`, replace the Status paragraph:

```md
Built in stages S4-1 to S4-6. S4-2 added `acpBackend()`: launch, connection,
capabilities, the session lifecycle and text turns. S4-3 added all four profiles:
mode by profile and permission requests decided by profile (`permissions.ts`), with
`ask` going to the caller through the facade's ask port. S4-4 adds embedder tools:
a per-session loopback MCP tool host (`tool-host.ts`, `tool-calls.ts`) and Claude
pre-approval (`pre-approval.ts`). Tested against a fake ACP agent
(`test/fixtures/fake-agent/`, in process and as a subprocess; its `mcpCall` step is
a real MCP client). Full events and usage (S4-5) and resume (S4-6) are refused with
`AGENT_SESSION_CAPABILITY_UNSUPPORTED` until then. `./server` is reserved for S5.
Nothing is released before S4-6.
```

with:

```md
Built in stages S4-1 to S4-6. S4-2 added `acpBackend()`: launch, connection,
capabilities, the session lifecycle and text turns. S4-3 added all four profiles:
mode by profile and permission requests decided by profile (`permissions.ts`), with
`ask` going to the caller through the facade's ask port. S4-4 added embedder tools:
a per-session loopback MCP tool host (`tool-host.ts`, `tool-calls.ts`) and Claude
pre-approval (`pre-approval.ts`). S4-5 adds turn events (thinking, tool calls,
usage) and elicitation as questions. Tested against a fake ACP agent
(`test/fixtures/fake-agent/`, in process and as a subprocess; its `mcpCall` step is
a real MCP client, and its `update` and `elicit` steps send any session update and
elicitation). Resume (S4-6) is refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`
until then. `./server` is reserved for S5. Nothing is released before S4-6.
```

Replace the module map row:

```md
| `turn.ts`, `events.ts`, `inbound.ts` | prompt turn and abort; text events; inbound routing by turn and session |
```

with:

```md
| `turn.ts`, `events.ts`, `inbound.ts` | prompt turn and abort; the turn's event collector; inbound routing (updates, permissions, elicitations) by turn and session |
| `stream-scrub.ts` | session secrets scrubbed from streamed agent text, holding back only a possible secret's start |
| `tool-events.ts` | `tool_call` / `tool_result` from ACP tool updates: sent when used, one result per call |
| `usage.ts` | per-turn tokens; the session's cost meter over cumulative reported cost |
| `elicitation.ts` | `elicitation/create` forms asked one field at a time as questions |
```

- [ ] **Step 5: Spec amendments**

In `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`:

(a) Replace the R9 row:

```md
| R9 | **Elicitation:** message-only and single-field forms become `question` events; richer forms are declined. |
```

with:

```md
| R9 | **Elicitation** (amended in S4-5, D5-i, maintainer ruling 2026-10-06): each field of a form becomes its own `question` event: free text, single-select and multi-select fields, with a `<key>_custom` free-text field folded into its select `<key>` (Claude's AskUserQuestion "Other" box). Other field types, oversized forms and non-form requests are declined. |
```

(b) In §5.1, replace:

```ts
  /** null on deadline, cancel or no active turn. */
  askQuestion(text: string): Promise<string | null>;
```

with:

```ts
  /** null on deadline, cancel (the turn signal or opts.signal, S4-5 D5-j) or no active turn. */
  askQuestion(text: string, opts?: { signal?: AbortSignal }): Promise<string | null>;
```

(c) In §6.6, replace:

```md
Agent-authored text is not scrubbed in S4-4 (S4-4 D4-m).
```

with:

```md
From S4-5 it is also scrubbed from agent-authored text and thinking, tool events and `turn_end.output` (S4-5 D5-g).
```

(d) Replace the whole of §6.7, from the heading `### 6.7 Event mapping and usage (\`events.ts\`)` up to (not including) `### 6.8`, with:

````md
### 6.7 Event mapping and usage (`events.ts`)

Amended in S4-5 (D5-a to D5-h) after reading claude-agent-acp 0.85.1.

| ACP `session/update` | Event |
|---|---|
| `agent_message_chunk` text | `text_delta { round: 0, text }` |
| `agent_message_chunk` non-text | dropped |
| `agent_thought_chunk` text | `thinking_delta { round: 0, text }` |
| `tool_call`, `tool_call_update` | merged per call (`tool-events.ts`); `tool_call` goes out when the call is used: a permission request names it, or its status is `in_progress`, `completed` or `failed` (D5-c) |
| `tool_call` / `tool_call_update` status `completed` or `failed` | `tool_result { callId, isError: status === "failed", preview }`, once per call (D5-e) |
| `usage_update` | its `cost` feeds the session's cost meter; no event |
| `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, any other update | dropped |
| `user_message_chunk`, and any update during `session/load` | suppressed |

- **Tool calls (D5-c to D5-f):**
  - `callId` is the agent's id, cleaned as for approval displays, so it equals `approval_requested.callId`; an id that holds a secret is dropped with its events.
  - `name`: the first non-empty `name` the agent sent (Claude: its tool name); else the first title that is non-empty and not a placeholder (`"tool call"`, `"Tool"`, case-insensitive); else `kind`; else `"tool"`. One line, visible characters, secrets scrubbed, at most 200 characters.
  - `input`: the latest `rawInput` when the event goes out (`{}` if none), secrets scrubbed, redacted and capped as native caps it.
  - `preview`: the latest content: text blocks, a `resource_link`'s `uri`, each diff as `edit <path> (+a -b)` (no counts above 1 MiB of text); `terminal` entries skipped (R11); else `rawOutput` when it is a string. Redacted and capped.
  - Every `tool_call` is followed by exactly one `tool_result`. At turn end, an announced call without one gets `isError: true` and `"Not answered: the turn ended."`. A call never used emits nothing. At most 512 calls are tracked per turn.
- **Text (D5-g):** `text_delta`, `thinking_delta` and `turn_end.output` have the session's secret values (`env` secrets of 8 or more characters, the tool host's token) replaced with `[REDACTED]`. Each stream holds back at most the longest such value's length minus one characters, so a value split across chunks is caught; held text goes out before the other stream's next delta, before any tool event and at turn end. No pattern redaction on deltas, as on native.

`round` is always 0. `stream_reset` and `compaction` are never emitted by the ACP backend. `turn_end.output` is the turn's concatenated agent message text.

**Usage** (per turn; one `usage` event per `PromptResponse`, D5-h):
- **Tokens (D5-a):** `PromptResponse.usage` (`inputTokens`, `outputTokens`, `thoughtTokens?`, `cachedReadTokens?`, `cachedWriteTokens?`) is taken as the turn's own usage. The protocol field is UNSTABLE and its comments contradict each other ("for this turn" vs "across all turns"); claude-agent-acp 0.85.1 resets it when a turn starts (`acp-agent.js` 2491).
- **Mapping:** output tokens = `outputTokens + thoughtTokens`; cache read and write map to `cacheRead` / `cacheWrite`, absent when not reported.
- **Cost (D5-b):** `usage_update.cost.amount` is cumulative for the session (USD only). The session's meter keeps the reading taken at the end of the last priced turn (0 for a new agent process; S4-6 resets it on reconnect and resume). A turn's cost is its latest reading minus that, `costSource: "reported"`; a negative difference reports the raw reading. A turn with no reading: `costUsd: 0`, `costSource: "unpriced"`, baseline unchanged.
- **No usage reported at all:** zeros with `unpriced`.
- **When:** after the turn's last delta and tool result, also for a stop reason other than `end_turn`. A turn that ends without a `PromptResponse` (abort, crash, JSON-RPC error) emits none. An errored turn's `turn_end.usage` stays zero, because the facade reads an errored turn's spend only from nax-agent's own turn error.

````

(e) Replace the whole of §6.8, from the heading `### 6.8 Elicitation → \`question\`` up to (not including) `### 6.9`, with:

````md
### 6.8 Elicitation → `question`

Amended in S4-5 (D5-i, maintainer ruling 2026-10-06). Advertised under `ask` and `full` (`elicitation.form`); under `none` and `read` a request is declined unasked. Responses use the protocol's actions `accept`, `decline` and `cancel`. Routing follows permissions (D5-k): only the bound session during a turn, under the shared cap of 16 pending inbound requests; anything else → `cancel`, no event.

- **Form shape:** only `mode: "form"` with a `requestedSchema` object. A `string` field without choices is free text; a `string` with `enum` or `oneOf` is a single-select; an `array` whose `items` has `enum`, `anyOf` or `oneOf` is a multi-select. A plain string field `<key>_custom` next to a select `<key>` is its companion and is not asked on its own.
- **Declined unasked:** any other field type, an empty or malformed choice list, more than 32 choices, more than 16 fields, a URL or unknown mode. `asks.noteQuestion("declined: <message>")`, then `decline`.
- **Message-only form:** `asks.askQuestion(message)`. A reply → `accept` with empty content; `null` → `cancel`.
- **Each other field is one question**, in order, asked under the turn binding's signal (`askQuestion(text, { signal })`, D5-j): the message (first question only), the field's title and description (`(i/n)` when there are several), numbered choices, and an instruction line.
- **Replies** (trimmed): empty skips an optional field and declines a required one. A single-select matches a choice by number, value or title, case-insensitively; no match goes to the companion, or declines without one. A multi-select splits on commas; unmatched parts join the companion with `", "`, or decline without one. Free text is taken as written. A decline after a reply is noted with `noteQuestion`.
- **No reply** (deadline, cancel, turn end, process exit) → `cancel`; later fields are not asked.
- **Question text** is agent data: control and invisible characters stripped, session secrets scrubbed, at most 4096 bytes.

````

(f) In §11.2, replace:

```md
   - a `usage` event with non-zero tokens
```

with:

```md
   - a `usage` event with non-zero tokens and `costSource: "reported"`; in a two-turn session the second turn's tokens are that turn's own (S4-5 D5-a)
   - a `tool_call` / `tool_result` pair for a file read, whose `input` names the file (S4-5 D5-c)
```

(g) In §12, replace the row:

```md
| Cumulative usage semantics differ per adapter | delta with reset handling; conformance asserts per-turn values |
```

with:

```md
| Usage semantics differ per adapter (the protocol field is UNSTABLE) | tokens taken per turn as Claude 0.85.1 reports them (S4-5 D5-a); cost differenced from cumulative readings with restart handling (D5-b); the live smoke checks a two-turn session |
```

- [ ] **Step 6: Regenerate and check**

Run (repo root):
```bash
bun packages/nax/bin/nax.ts generate --all-packages
git status --short
```
Expected: only `packages/nax-agent-acp/{CLAUDE,AGENTS,GEMINI,codex}.md` change among generated files. If other packages' generated files change, the generator picked up unrelated drift; revert those and note it in the PR body.

Run (from `packages/nax-agent-acp`): `bun run check:api`
Expected: PASS with no snapshot change. S4-5 adds no export to `./client`.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent-acp/src/client/index.ts packages/nax-agent-acp/README.md packages/nax-agent-acp/CHANGELOG.md .nax/mono/packages/nax-agent-acp/context.md packages/nax-agent-acp/CLAUDE.md packages/nax-agent-acp/AGENTS.md packages/nax-agent-acp/GEMINI.md packages/nax-agent-acp/codex.md docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md
git commit -m "docs(nax-agent-acp): S4-5 events, usage and questions on ACP; spec usage, elicitation and askQuestion amendments"
```

---

### Task 10: Whole-repo gates, review, billed smoke, PR

- [ ] **Step 1: Run the repo-wide gates**

Run (repo root):
```bash
bun run typecheck
bun run check:all
bun run build
bun run test
```
Expected: all exit 0.

Run from `packages/nax-agent-acp` as CI does:
```bash
bun run check:api && bun run test:coverage && bun run test:node
```
Expected: all exit 0. Each new src file (`stream-scrub.ts`, `usage.ts`, `tool-events.ts`, `elicitation.ts`) is at or above 80%, and the per-file coverage baseline stays empty.

Run from `packages/nax-agent`:
```bash
bun run check:api && bun run test
```
Expected: exit 0, no snapshot change.

- [ ] **Step 2: Confirm the scope fence**

Run:
```bash
git diff --stat origin/main...HEAD -- packages/nax/ | cat
git diff --stat origin/main...HEAD -- packages/nax-agent/ | cat
```
Expected: the first is empty. The second lists exactly `src/session/session-backend.ts`, `src/session/session-ask-port.ts`, `test/unit/session/session-ask-port.test.ts` and `CHANGELOG.md`.

- [ ] **Step 3: Review before push**

Dispatch one code-review subagent (sonnet) over `git diff origin/main...HEAD`. Give it:
- spec §6.3 (step 1.1, step 5, inbound with no active turn), §6.7 and §6.8 as amended in Task 9, §5.1 `askQuestion`
- this plan's Decisions and Review Focus

Fix CRITICAL and HIGH findings, with at most two fix rounds.

- [ ] **Step 4: Billed `nax run` S1-recipe smoke (S4-0 Done-when; maintainer approval at launch)**

Task 0 changes nax-agent `src/session/`, so spec §10's S4-0 Done-when applies. Ask the maintainer for approval before launching; do not launch without it. Follow the recipe in the maintainer workspace memory "S1 smoke fixture recovery": rebuild the clamp-helper PRD from the newest `~/.nax/nax-s*-smoke/prompt-audit/` implementer prompt, give `.nax/config.json` the unique name `nax-s4-5-smoke`, run `nax trust add <dir> --yes`, and run the local build from this branch's head:

```bash
bun <repo>/packages/nax/bin/nax.ts run -f s1-smoke -a native --headless --max-cost 2
```

Checks: `naxCommit` on `run.start` equals the branch head; 1/1 story passed with its five ACs; the pre-run auto-commit's parent is the head and changes only config and features; the cost jsonl keys match the S4-0 run; the tool-audit errors are the known ones (sort.ts ENOENT reads, the TDD red-step testScoped failure, the `:!__tests__/` pathspec). Record the cost, duration and result for the PR body.

- [ ] **Step 5: Push and open the PR (maintainer approval first)**

After approval:
```bash
git push -u origin feat/s4-5-acp-events-usage
gh pr create --base main --title "feat(nax-agent-acp): S4-5 turn events, usage and elicitation" --body-file <body>
```

The body covers:
- the S4-5 scope (spec §10 row)
- decisions D5-a to D5-m, with the D5-a and D5-b evidence (adapter file references) and the two maintainer rulings (D5-i, D5-j)
- the README "Events and usage on ACP" and "Questions from the agent" guarantees, and the known limit (errored `turn_end.usage` is zero)
- the nax-agent change (`askQuestion(text, { signal })`) and the billed smoke result
- the test plan: CI jobs `nax-agent-acp`, `nax-agent-acp: node 22/24`, `nax-agent`, `nax`, `tooling`
- a statement that nothing is released and that `packages/nax/` is untouched

---

## Self-review notes

- **Spec coverage, §6.7 (as amended):**
  - text and thought rows: Task 4 (collector), Task 7 (end to end)
  - non-text chunks, plans, mode, config, user chunks dropped: Task 4
  - updates during `session/load` suppressed: S4-6 (no load path exists yet)
  - tool timing, names, input, preview, one result per call, the 512 cap: Task 3; announce from permissions: Task 6 (router), Task 7 (order)
  - `round` 0, no `stream_reset` / `compaction`, `turn_end.output`: Task 4, Task 7
  - usage tokens per turn, mapping, cost difference with restart and unpriced handling, no-usage zeros: Task 2; on the turn and for non-`end_turn` stops: Task 4, Task 7
  - text scrubbing incl. split secrets and the tool-host token: Task 1, Task 4, Task 7
- **§6.8 (as amended):** advertisement by profile: Task 6 (`clientCapabilitiesFor`), Task 7 (read); form shapes, companions, declines, message-only, replies, no-reply cancel, hygiene: Task 5; routing (bound session, request-scoped, cap, release): Task 6; signal (D5-j): Task 0, Task 5, Task 7 (cancel and crash).
- **§6.3:** step 1.1 `elicitation.form` under `ask`/`full`: Task 6. Step 5 questions settle `cancelled` at once on process death: Task 0, Task 7. "Inbound requests with no active turn" → elicitation `cancel`: Task 6.
- **§5.1 `askQuestion` signal:** Task 0, spec text in Task 9.
- **Type consistency:**
  - `TurnCollector` (`onUpdate`, `announce`, `finish`, `settle`, `output`) is used by `turn.ts` (Task 4), `inbound.ts` (Task 6) and `backend.ts` (Task 6)
  - `createTurnCollector(emit, { secrets, meter })` matches its call in `backend.ts`; `CostMeter` from Task 2 is the type of `Live.meter`
  - `ElicitationHandler` (Task 6) matches `answerElicitation(request, { ...base, signal })` with `ElicitationContext` (Task 5)
  - `InboundHandlers.onElicitation` (Task 6) is satisfied by the router's handlers and by both `connection.test.ts` literals
  - `cleanCallId(value, secrets)` (Task 1) is used by `tool-display.ts` and `tool-events.ts` (Task 3)
  - the fake's `update` / `elicit` steps and `text.echoMcpAuth` (Task 6) match their use in Tasks 6, 7 and 8
- **Placeholder scan:** none.
