# SPEC: review e684f920 fixes: final-only text and malformed final-only tool arguments in the pi client

## Summary

Two fixes in `packages/nax-ai/src/protocols/pi-client.ts` from the verified code review of `e684f9205` (findings 8 and 9):

1. **Final-only response text is emitted (finding 8).** On `text_end`, the client compares the block's completed `content` with the text it already emitted for that `contentIndex` through `text_delta`, and emits the missing remainder as one `text-delta`. An ordinary delta stream emits its text exactly once, as today; a block that arrived only as the completed item is no longer lost.
2. **Malformed final-only tool arguments are an error (finding 9).** On `toolcall_end`, when pi reports `argumentsError` and no argument deltas were accumulated, the client ends with the existing bad-request error instead of a successful tool call with `{}`.

## Motivation

The review (`review-e684f920/REVIEW.md`) confirmed both defects at `e684f9205` through the public client with an offline stream:

- **Finding 8.** pi-ai's OpenAI Responses adapter (`openai-responses-shared.js`, `response.output_item.done`) sets the block text from the completed item and pushes `text_end` with `content`, whether or not `text_delta` events preceded it. `createPiProtocol` maps only `text_delta` to `text-delta`; `text_end` falls into the `default:` branch, whose comment assumes the deltas already delivered the content. A stream answering `42` only on the completed item returned empty text with a successful stop and billed usage. Production frequency is unknown.
- **Finding 9.** `toolcall_end` parses `pending?.raw ?? ""` with `parseToolArgs`, which returns `{}` for `""`, and `completedToolInput` returns that accumulation whenever `argumentsError` is set. With no deltas and a malformed final JSON, the client emitted a successful tool call with input `{}`, which a tool whose arguments are all optional accepts.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax-ai/src/protocols/tool-args.ts`: `parseToolArgs(raw)` (`""` → `{}`, else `JSON.parse`), `createToolArgAccumulator()` with `append(id, name, delta)` and `take(id)` (returns `undefined` when no delta was appended for the id).
- pi-ai events (`@earendil-works/pi-ai` 1.4.0): `text_delta { contentIndex, delta }`, `text_end { contentIndex, content }`, `toolcall_end { toolCall: { id, name, arguments, argumentsError? } }`.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- The event loop in `createPiProtocol(...).stream` (`packages/nax-ai/src/protocols/pi-client.ts`).
  - Baseline: `text_delta` yields `{ type: "text-delta", text: event.delta }`; `text_end` is ignored.
  - Target: the stream keeps a per-stream `Map<number, string>` of text emitted per `contentIndex`. `text_delta` appends `event.delta` to its index's entry and yields as today. `text_end` reads the entry for its `contentIndex` (`""` when absent): when `event.content` starts with it and is longer, it yields one `{ type: "text-delta", text: event.content.slice(emitted.length) }`; when `event.content` equals it, or does not start with it, nothing is yielded (text already emitted cannot be retracted). The entry is then removed; entries for blocks that never get a `text_end` are simply dropped with the stream (no flush). The `default:` branch comment that says `text_end` carries nothing is updated.
- `toolcall_end` handling (same file).
  - Baseline: `input = parseToolArgs(pending?.raw ?? "")`, then `completedToolInput(event.toolCall, input)`.
  - Target: when `event.toolCall.argumentsError !== undefined` and no non-empty accumulation exists (`pending === undefined` or `pending.raw === ""`), it sets `malformedToolArgs` to the existing bad-request error (`Tool "<name>" returned unparseable arguments.`, `cause: event.toolCall.argumentsError`) and yields no tool call, exactly like the accumulated-JSON parse failure. The `completedToolInput` doc comment (which says `argumentsError` keeps the accumulation) is updated to name this case. Every other case is unchanged: no `argumentsError` with `arguments` `{}` yields input `{}`; `argumentsError` with a parseable accumulation yields the accumulation.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| `text_end` content diverges from the emitted deltas | Nothing more is emitted for that block; the deltas stand. |
| `argumentsError` with no usable accumulation | Draining continues to the terminal event for usage, then one bad-request error, as for an unparseable accumulation. |

## Out of Scope

- Findings 1-7 and 10-13 of review e684f920 belong to the other three review-e684 features (acp-sessions, chat, workflow-verification).
- Thinking blocks are unchanged; their completed content already comes from `thinking_end`.
- Reconciling text from the terminal `done` message's content blocks, for a block that never received `text_end`, is not done.
- The existing test title in `packages/nax-ai/test/protocols/pi-client.test.ts` that says `text_end` is dropped is left as is; its assertion still holds.
- A `text_end` whose content diverges from the emitted deltas is not reported as an error or warning.

## Stories

**US-001: reconcile final-only text and refuse malformed final-only tool arguments (findings 8 and 9).** Workdir: `packages/nax-ai`. No dependencies. `text_end` emits the remainder its deltas did not deliver; `toolcall_end` with `argumentsError` and no accumulation ends with the bad-request error.

### Context Files

**US-001**
- `packages/nax-ai/src/protocols/pi-client.ts` — `createPiProtocol`, `completedToolInput`, the `toolcall_end` and `done` branches
- `packages/nax-ai/src/protocols/tool-args.ts` — `parseToolArgs`, `createToolArgAccumulator`
- `packages/nax-ai/test/protocols/pi-client.test.ts` — the `fakePi(events)` / `drain` harness and the ordinary-delta-stream test
- `packages/nax-ai/test/protocols/pi-client-final-args.test.ts` — `argumentsDelta`, `callEnd(arguments, argumentsError?)`, `done()` builders

### Creates

**US-001**
- `packages/nax-ai/test/protocols/pi-client-final-text.test.ts` — the final-only text tests (ACs 1-6, 11), with its own small local event builders (`pi-client.test.ts` is over the 800-line limit and its `fakePi` must not be imported from a test file)

### Modifies

**US-001**
- `packages/nax-ai/src/protocols/pi-client.ts` — the `text_end` reconciliation and the `toolcall_end` bad-request branch, plus the two doc comments named in Design.
- `packages/nax-ai/test/protocols/pi-client-final-args.test.ts` — the final-only malformed-argument tests (ACs 7-10, 12) are added here, reusing its `argumentsDelta`, `callEnd(arguments, argumentsError?)` and `done()` builders; no existing assertion changes.

### Seams

- None: the change is inside `createPiProtocol`, and every AC drives it through `createPiProtocol(...).stream` or the public `createClient(...).complete`.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

1. [unit] A stream of `text_start` (index 0), `text_end` (index 0, content `42`) and `done` makes `createPiProtocol(...).stream` yield exactly one `text-delta` with text `42`.
2. [integration] Through `createClient` with a `ProtocolFactory` returning `createPiProtocol("openai-responses", ...)` over a fake pi stream of `text_start` (index 0), `text_end` (index 0, content `42`) and `done`, with a provider catalog built as in `test/client.test.ts`, `complete` returns text `42`.
3. [unit] (control) A stream of `text_delta` `he`, `text_delta` `llo` and `text_end` content `hello` at index 0 yields exactly the two deltas `he` and `llo`, and no other `text-delta`.
4. [unit] A stream of `text_delta` `he` and `text_end` content `hello` at index 0 yields `text-delta` `he` then `text-delta` `llo`.
5. [unit] (control) Through `createPiProtocol(...).stream`, a stream of `text_delta` `abc` and `text_end` content `xyz` at index 0 yields only the `abc` delta.
6. [unit] Through `createPiProtocol(...).stream`, a stream of `text_delta` `A` at index 0, `text_end` content `A` at index 0, `text_start` at index 1, `text_end` content `B` at index 1 and `done` yields `text-delta` `A` and then exactly one `text-delta` `B`.
7. [unit] Through `createPiProtocol(...).stream`, a `toolcall_end` with `arguments` `{}`, `argumentsError` `Tool arguments must be a JSON object` and no preceding argument delta yields no `tool-call` event.
8. [unit] Through `createPiProtocol(...).stream`, a `toolcall_end` with `arguments` `{}`, `argumentsError` `Tool arguments must be a JSON object` and no preceding argument delta, followed by `done`, ends the stream with a `usage` event and then an `error` event of kind `bad-request` whose message is `Tool "lookup" returned unparseable arguments.` and whose `cause` is the `argumentsError` string.
9. [unit] (control) Through `createPiProtocol(...).stream`, a `toolcall_end` with `arguments` `{}`, no `argumentsError` and no delta yields one `tool-call` whose input is `{}`.
10. [unit] (control) Through `createPiProtocol(...).stream`, a `toolcall_end` with `argumentsError` after the delta `{"city":"SG"}` yields one `tool-call` whose input is `{ city: "SG" }`.
11. [unit] (control) Through `createPiProtocol(...).stream`, a stream of `text_delta` `hello` and `text_end` content `he` at index 0 yields only the `hello` delta, and a lone `text_end` with empty content at index 1 yields no `text-delta`.
12. [unit] Through `createPiProtocol(...).stream`, a `toolcall_end` with `argumentsError` after a single empty-string argument delta (`""`) yields no `tool-call` and ends with the `bad-request` error.
