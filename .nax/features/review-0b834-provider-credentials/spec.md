# SPEC: review 0b834ecc fixes: final tool arguments, terminal reasoning signatures, HTTP retry interval, runnable picker models, credential store shape and lock deadline

## Summary

Six fixes from the verified code review of `0b834ecc1` (findings 3, 7, 8, 9, 10 and 11), each reproduced by the review's provider proof:

1. **Final tool arguments (finding 3).** When a tool call ends, the pi-backed protocol emits the arguments pi-ai finalised from the completed tool-call item, not only the argument deltas it accumulated. A call whose arguments arrive only on `output_item.done`, or whose completed item corrects earlier deltas, now reaches the caller with the completed arguments.
2. **Terminal reasoning signatures (finding 7).** The protocol emits each `thinking` block when the stream finishes, with the signature pi-ai holds at that point. A reasoning item whose `encrypted_content` arrives only in the terminal response is then replayed on the next stateless (`store: false`) turn.
3. **HTTP retry interval (finding 8).** On an HTTP error response (for example 429 or 503), the protocol reads the response's status and `Retry-After` header before the SDK discards them, so the error carries `retryAfter` and the native retry waits the interval the provider asked for.
4. **Runnable picker models (finding 9).** The chat model picker offers only catalog models whose protocol nax registers. A model on an unregistered protocol (for example a Google model) is no longer offered only to fail with `Unknown protocol`.
5. **Credential store shape (finding 10).** The credential file store refuses to read or write a file that is not a version 1 store with a credentials map. It no longer rewrites an array of credentials, or a file of another version, into a version 1 map with a numeric `"0"` key.
6. **Credential lock deadline (finding 11).** `lockTimeoutMs` bounds the whole lock acquisition, not each sleep between attempts. A lock released after the deadline is not acquired, and a lock that stays held fails at about the deadline rather than at a multiple of it.

## Motivation

The review (`review-0b834ecc/REVIEW.md`, proof `review-0b834ecc/proofs/provider-recheck.ts`) reproduced each defect through a real nax-ai client and pi-ai with a local `fetch`, with a passing control:

- **Finding 3.** The normal delta sequence and an `arguments.done` event alone both returned `city: "KL"`. With the arguments only on `response.output_item.done`, pi-ai's final message held `KL` but nax returned empty input. When the completed item corrected an earlier `SG` delta to `KL`, nax kept `SG`. The `toolcall_end` case in `createPiProtocol` parses only what `createToolArgAccumulator` collected from `toolcall_delta` events. pi-ai replaces the call's arguments from the completed item but does not emit that replacement as a delta.
- **Finding 7.** With `encrypted_content` on the completed reasoning item, the second request replayed it. With `encrypted_content` only in `response.completed`, pi-ai's final message held it (pi-ai backfills it in `finalizeResponse`), but the replay omitted it. The protocol emits the `thinking` event on `thinking_end`, which pi-ai pushes before the terminal response arrives.
- **Finding 8.** Injected 429 and 503 responses with `Retry-After: 41` kept their status but lost the header, and `turnRetryDelayMs` chose 1 second. The control, a 200 response carrying a streamed error with the same header, chose 41 seconds. pi-ai calls `onResponse` only after the SDK returns a successful response. On an HTTP error the SDK throws first, so `observed` stays undefined and `parseRetryAfter(observed?.headers)` returns undefined. The status survives only because `statusFromSdkMessage` reads it from the message text.
- **Finding 9.** With Google and OpenAI credentials, `chatModelChoices` offered models from both providers. A selected OpenAI model completed. A selected Google model failed with `Unknown protocol`, because the native client registers only `DEFAULT_PROTOCOL_NAMES` and `listCatalogModels` filters on `supportsTools` alone.
- **Finding 10.** A valid version 1 map kept its entries when a credential was added. A version 1 file whose credentials were an array, and a version 2 file, were both rewritten as version 1 with keys `"0"` and the new provider. `readShape` checks only that the parsed value is an object with a `credentials` key.
- **Finding 11.** With `lockTimeoutMs: 20`, a writer acquired a lock released after 80 ms, and a lock held throughout timed out after about 226 ms. `withLock` passes `lockTimeoutMs` to proper-lockfile as `maxTimeout`, the cap on each of ten retry sleeps, so the total wait is unrelated to the option.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax-ai/src/protocols/pi-client.ts`: `thinkingBlockAt(partial, index)` returns `{ signature?, redacted? }` read off the thinking block at a content index; `toolCallAt(partial, index)`; `parseRetryAfter` and `statusFromSdkMessage` (from `./errors.ts`); `PiResponse` (`{ status, headers }`); `PiStreamFn`, whose fourth parameter is `onResponse`.
- `packages/nax-ai/src/protocols/tool-args.ts`: `createToolArgAccumulator()`, `parseToolArgs(raw)` (an empty string parses to `{}`; otherwise `JSON.parse`).
- `packages/nax-ai/src/protocols/collect.ts`: `collectStream` pushes every `thinking` event's block into `CompleteResult.thinking` in arrival order; `ProtocolStreamError` carries the `error` event's payload as `protocolError`.
- pi-ai 1.5.0 (`@earendil-works/pi-ai`, read through `pi-client.ts` only): a `toolcall_end` event's `toolCall` is `{ id, name, arguments: JsonObject, argumentsError?: string }`, where `argumentsError` is set when the completed arguments text was not a JSON object (then `arguments` is `{}`). `SimpleStreamOptions.fetch` is honoured by the `anthropic-messages`, `openai-completions`, `openai-responses` and `openai-codex-responses` adapters, the four protocols nax registers.
- `packages/nax-ai/src/protocols/pi-protocols.ts`: `DEFAULT_PROTOCOL_NAMES` (`anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`), exported from `@nathapp/nax-ai`.
- `packages/nax-ai/src/providers/types.ts`: `ResolvedModel.protocol` (string) and `ResolvedModel.supportsTools`.
- `packages/nax/src/chat/chat-models.ts`: `chatModelChoices(input)`, which appends `input.listCatalogModels(input.availableProviders)` after the configured tiers and `catalogOverrides`. Unchanged.
- `packages/nax/src/cli/chat.ts`: `discoverModels` passes the production `listCatalogModels` to `chatModelChoices`. Unchanged.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- The `toolcall_end` case of `createPiProtocol(...).stream` (`packages/nax-ai/src/protocols/pi-client.ts`).
  - Baseline: parses the accumulated delta text with `parseToolArgs`; on a parse failure it records the `bad-request` error `Tool "<name>" returned unparseable arguments.` and drains; otherwise it emits `tool-call` with the parsed accumulation as `input`.
  - Target: the parse-failure path is unchanged. When the accumulation parses, `input` is `event.toolCall.arguments` if `event.toolCall.argumentsError` is absent and `event.toolCall.arguments` is a non-null, non-array object; otherwise `input` is the parsed accumulation, as today.
- The `thinking_end` and terminal cases of `createPiProtocol(...).stream`.
  - Baseline: `thinking_end` immediately emits `{ type: "thinking", block: { text, signature?, redacted? } }`, with `signature` and `redacted` read by `thinkingBlockAt(event.partial, event.contentIndex)`.
  - Target: `thinking_end` holds the block, with its content index, instead of emitting it. The held blocks are emitted in the order their `thinking_end` events arrived:
    1. On `done`, before the `usage` event. For each held block, `thinkingBlockAt(event.message, contentIndex)` is read; its `signature` replaces the held signature when present, and its `redacted` replaces the held flag when present. A field absent from the terminal block keeps the held value. The text is always the `thinking_end` text.
    2. On every other end of the stream (an `error` event, the malformed-arguments drain ending on `done` or `error`, a stream that ends with no terminal event, and a thrown failure), the held blocks are emitted with their `thinking_end` values, before the first event that path emits (`usage` or `error`). When the request was aborted, the flush is skipped: an aborted `error` event still emits its `usage` (when non-zero) and rethrows the abort as today, and a thrown failure on an aborted request rethrows it as today, in both cases without emitting the held blocks.
  - Signatures stay opaque: they are copied, never compared or inspected.
- `createPiDeps(...).stream` (`packages/nax-ai/src/protocols/pi-client.ts`).
  - Baseline: passes pi-ai `onResponse: (response) => onResponse({ status, headers })` and no `fetch`.
  - Target: also passes `fetch: observeErrorResponses(onResponse)`. The `onResponse` option stays as it is.
- New `observeErrorResponses(onResponse)` in new file `packages/nax-ai/src/protocols/error-response-fetch.ts`. It imports nothing from pi-ai (`check:pi-ai-imports`) and no Bun API (`check:no-bun-apis`).
  - Target: returns a function with the signature of `globalThis.fetch`. Each call forwards its arguments to `globalThis.fetch`, read at call time (so a test stub installed after construction is used). When the returned `Response` has a status of 400 or above, it calls `onResponse({ status, headers })` with the headers as a plain record of the response's header names and values, then returns the same `Response` untouched. A response below 400 is returned without calling `onResponse`. A rejected `fetch` rejects with the same reason, without calling `onResponse`.
  - Effect: on an HTTP error, `observed` holds the error response, so the existing `error` case reads `status` and `retryAfter` from it. When pi-ai retries a failed request and the retry succeeds, pi-ai's own `onResponse` call overwrites `observed`, as today.
- `listCatalogModels(providerIds)` (`packages/nax/src/agents/catalog/index.ts`).
  - Baseline: lists `provider/id` for each catalog model with `supportsTools`.
  - Target: also requires `DEFAULT_PROTOCOL_NAMES` (imported from `@nathapp/nax-ai`) to include `model.protocol`. Order, the `supportsTools` filter and the empty result on a catalog load failure are unchanged.
- `readShape(path)` (`packages/nax-ai/src/credentials/file-store.ts`).
  - Baseline: throws when the JSON does not parse, or when the value is not an object holding a `credentials` key; returns `EMPTY` on `ENOENT`.
  - Target: additionally throws `The credential file at <path> is not a version 1 credential store. Refusing to overwrite it.` when `version` is not the number `1`, and the existing `could not be parsed as a credential store. Refusing to overwrite it.` error when `credentials` is null, an array, or not an object. Neither message includes file content. `read`, `modify` and `delete` all go through `readShape`, so each throws on such a file and `modify` writes nothing.
- `withLock(fn)` in `createFileCredentialStore` (`packages/nax-ai/src/credentials/file-store.ts`).
  - Baseline: one `lockfile.lock(path, { realpath: false, stale: STALE_MS, retries: { retries: 10, factor: 1.6, minTimeout: 20, maxTimeout: lockTimeoutMs } })`.
  - Target: acquisition runs against one deadline, `lockTimeoutMs` after the first attempt. Each attempt calls `lockfile.lock` with `retries: 0`. On `ELOCKED`, if the deadline has passed it throws the existing `Timed out waiting for the credential file lock at <path>. Another process is holding it.` error with the `ELOCKED` error as `cause`; otherwise it sleeps the next backoff (starting at 20 ms, growing by 1.6, never past the time left to the deadline) and tries again. Any other error propagates as today. `DEFAULT_LOCK_TIMEOUT_MS` (5000) and `STALE_MS` are unchanged.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| The accumulated tool-argument text is not JSON | Unchanged: `bad-request` `Tool "<name>" returned unparseable arguments.`, after the terminal usage. |
| pi-ai marks the completed arguments with `argumentsError` but the accumulation parses | The parsed accumulation is used, as today. |
| The stream ends on an error, a drain or a throw while thinking blocks are held | The held blocks are emitted with their `thinking_end` values before the terminal events. |
| An HTTP error response has no `Retry-After` header, or a non-numeric one | `retryAfter` stays absent (`parseRetryAfter` returns undefined); `status` comes from the observed response. |
| The underlying `fetch` rejects (no HTTP response) | The rejection reaches pi-ai unchanged; `onResponse` is not called. |
| The credential file has `version` 2, or a credentials array | `read`, `modify` and `delete` throw; the file is left byte-for-byte unchanged. |
| The lock is held past `lockTimeoutMs` | `modify` throws the `Timed out waiting for the credential file lock` error and the callback never runs. |

## Out of Scope

- Findings 1, 2 and 4-6, 12-17 and 19-22 of review 0b834ecc belong to the other review-0b834 features (agent-acp, release-config-ci and workflow-verification), which are merged; finding 18 was withdrawn as a CLI defect.
- No live provider was shown to emit the finding 3 or finding 7 sequences; the fixes are verified against local responses only, and no live test is added.
- US-001 only: a custom (grammar) tool call is not given separate handling; its `toolcall_end` takes `toolCall.arguments` under the same rule as a JSON call.
- US-001 only: no AC covers deltas that parse to a non-empty object while `toolCall.arguments` is `{}` with no `argumentsError`; pi-ai 1.5.0 replaces the delta text only when the completed item's arguments are non-empty, so it does not produce that state, and the rule then emits `{}`.
- US-001 only: a tool call whose accumulated delta text is not JSON still ends the stream with the `bad-request` error, even when pi-ai's completed arguments are valid.
- US-002 only: `thinking-delta` events are still emitted as they arrive; only the complete `thinking` block moves to the end of the stream.
- US-003 only: the native retry policy in `packages/nax-agent` (`turnRetryDelayMs`, `isRetryableTransportFault`) is unchanged; it already honours `retryAfter`.
- US-003 only: an HTTP-date `Retry-After` value is not parsed; `parseRetryAfter` accepts seconds only, as today.
- US-003 only: pi-ai's own in-adapter request retries are not changed or configured.
- US-004 only: the individual credential entries inside a valid version 1 map are not validated.
- US-004 only: no migration from another version or from an array layout is added; such a file is refused, not converted.
- US-004 only: `STALE_MS` and the stale-lock breaking behaviour of proper-lockfile are unchanged.
- US-004 only: a `lockTimeoutMs` of 0 or below is not newly validated.
- US-005 only: configured tier models and `agent.native.catalogOverrides` entries stay in the picker regardless of protocol, because they are explicit local declarations.
- US-005 only: the native client's registered protocols are not read at runtime; the picker uses `DEFAULT_PROTOCOL_NAMES`, which is what `buildNativeClient` registers.
- US-004 only: `nax auth list` keeps its own looser check of the credential file (`readStoredEntries` in `packages/nax-agent/src/native/credentials/index.ts`), so it may list a provider from a file the store now refuses to read.
- US-003 only: pi-ai's `anthropic-messages` federation client is rebuilt when the `fetch` it was built with changes; nax does not configure federation, so the per-request wrapper is not memoised.

## Stories

**US-001: the stream emits pi-ai's completed tool arguments (finding 3).** Workdir: `packages/nax-ai`. No dependencies. In `createPiProtocol(...).stream`, `toolcall_end` emits `event.toolCall.arguments` when the accumulated delta text parses and pi-ai reports no `argumentsError`; otherwise it keeps today's behaviour.

**US-002: the stream emits thinking blocks with their terminal signatures (finding 7).** Workdir: `packages/nax-ai`. Depends on US-001. `thinking_end` holds each thinking block instead of emitting it. `done` emits the held blocks before `usage`, with the signature and redacted flag read off the terminal message. Every other ending emits them with their `thinking_end` values before its first event, except an aborted request, which rethrows without them.

**US-003: HTTP error responses keep their status and Retry-After (finding 8).** Workdir: `packages/nax-ai`. No dependencies. New `observeErrorResponses` in `src/protocols/error-response-fetch.ts` wraps `globalThis.fetch` and reports a response of status 400 or above to `onResponse`. `createPiDeps(...).stream` passes it to pi-ai as the `fetch` option, so the `error` case reads `status` and `retryAfter` from the observed error response.

**US-004: the credential file store refuses incompatible files and enforces one lock deadline (findings 10 and 11).** Workdir: `packages/nax-ai`. No dependencies. `readShape` refuses a file whose `version` is not 1 or whose `credentials` is not a map. `withLock` retries `lockfile.lock` against one deadline `lockTimeoutMs` after the first attempt.

**US-005: the chat model picker lists only catalog models on registered protocols (finding 9).** Workdir: `packages/nax`. No dependencies. `listCatalogModels` keeps a model only when `DEFAULT_PROTOCOL_NAMES` includes its `protocol`.

### Context Files

**US-001**
- `packages/nax-ai/src/protocols/pi-client.ts` — `createPiProtocol`, the `toolcall_delta` and `toolcall_end` cases
- `packages/nax-ai/src/protocols/tool-args.ts` — `createToolArgAccumulator`, `parseToolArgs`
- `packages/nax-ai/test/protocols/pi-client-tool-args.test.ts` — `fakePi(events)`, `message(...)`, `drain(...)` and the malformed-arguments drain tests
- `packages/nax-ai/test/protocols/pi-client-thinking-budget.test.ts` — the real-pi harness: `vi.stubGlobal("fetch", ...)`, `createClient` with `defaultProviders()`, a `protocols` factory built on `defaultProtocols` with a memory credential store, `transportRetries: 0`

**US-002**
- `packages/nax-ai/src/protocols/pi-client.ts` — the `thinking_end`, `done`, `error` and catch paths, the malformed-arguments drain, `thinkingBlockAt`
- `packages/nax-ai/test/protocols/pi-client.test.ts` — the existing `thinking_end` tests
- `packages/nax-ai/test/protocols/pi-client-tool-args.test.ts` — `fakePi(events)`, `message(...)`, `drain(...)`
- `packages/nax-ai/src/protocols/collect.ts` — `collectStream`, how `thinking` events become `CompleteResult.thinking`
- `packages/nax-ai/test/protocols/pi-client-thinking-budget.test.ts` — the real-pi harness

**US-003**
- `packages/nax-ai/src/protocols/pi-client.ts` — `createPiDeps`, `PiResponse`, the `error` case that reads `observed`
- `packages/nax-ai/src/protocols/errors.ts` — `parseRetryAfter`, `statusFromSdkMessage`
- `packages/nax-ai/test/protocols/pi-client-thinking-budget.test.ts` — the real-pi harness
- `packages/nax-ai/src/protocols/collect.ts` — `ProtocolStreamError.protocolError`

**US-004**
- `packages/nax-ai/src/credentials/file-store.ts` — `readShape`, `withLock`, `createFileCredentialStore`
- `packages/nax-ai/test/credentials/file-store.test.ts` — temp-directory setup and the refuse-to-overwrite tests

**US-005**
- `packages/nax/src/agents/catalog/index.ts` — `listCatalogModels`, `_catalogDeps`
- `packages/nax/test/unit/agents/catalog/list-models.test.ts` — the `provider(id)` fixture and `_catalogDeps.loadProviders` stub
- `packages/nax/src/chat/chat-models.ts` — `chatModelChoices`

### Creates

**US-001**
- `packages/nax-ai/test/protocols/pi-client-final-args.test.ts` — completed-arguments tests

**US-002**
- `packages/nax-ai/test/protocols/pi-client-terminal-thinking.test.ts` — held-thinking tests

**US-003**
- `packages/nax-ai/src/protocols/error-response-fetch.ts` — `observeErrorResponses`
- `packages/nax-ai/test/protocols/error-response-fetch.test.ts` — unit and real-pi Retry-After tests

**US-004**
- `packages/nax-ai/test/credentials/file-store-shape.test.ts` — incompatible-file tests
- `packages/nax-ai/test/credentials/file-store-lock-deadline.test.ts` — lock-deadline tests

**US-005**
- `packages/nax/test/unit/agents/catalog/list-models-protocol.test.ts` — registered-protocol tests

### Modifies

**US-001**

None. The existing tool-argument tests give `toolcall_end` arguments that match the accumulated deltas, or malformed deltas that still take the `bad-request` path.

**US-002**

None. The existing `thinking_end` tests end with `done` messages whose content holds no thinking block, so the held values are emitted unchanged, and they assert with `toContainEqual` or `find`, not on event order.

**US-003**

None. The existing real-pi harness in `pi-client-thinking-budget.test.ts` stubs `fetch` with a 401 response and asserts only that an `error` event appears.

**US-004**

None. The existing file-store tests write version 1 files with a credentials map, or unparseable JSON.

**US-005**
- `packages/nax/test/unit/agents/catalog/list-models.test.ts` — its `provider(id)` fixture gives every model `protocol: "test"`, which `DEFAULT_PROTOCOL_NAMES` does not include, so AC-1 to AC-3 would list nothing. The invariant: the fixture's models (and `defaultProtocol`) use `openai-completions`, and AC-1 to AC-4 keep their expected lists and call counts.

### Seams

None across stories. US-003's new `observeErrorResponses` is consumed by `createPiDeps` in the same story, and its wiring is pinned by US-003's real-client ACs. US-002 depends on US-001 only because both change `createPiProtocol(...).stream`.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

"Drain" means iterating `createPiProtocol("openai-responses", deps).stream(request)` to its end, where `deps.stream` yields the scripted pi-ai events listed and `deps.resolveModel` returns a fixed model, as `fakePi` does in `pi-client-tool-args.test.ts`. "The real-pi client" means `createClient` with `defaultProviders()`, `transportRetries: 0` and a `protocols` factory returning `defaultProtocols({ credentials, providerOverrides })` over a memory credential store holding an api key for `openai`, with `globalThis.fetch` stubbed; requests go to `await client.model("openai", "gpt-5.4")`. A stubbed server-sent-event stream delivers each event in its own macrotask (for example with a short timer between enqueues), never all at once, so nax reads each pi-ai event before the next one is parsed.

### US-001

A "tool call t1" is a `toolCall` block with id `t1` and name `lookup`.

1. [unit] When `toolcall_delta` events carry `{"city":"SG"}` and the `toolcall_end` event's `toolCall.arguments` is `{ city: "KL" }` with no `argumentsError`, draining yields a `tool-call` event for t1 with `input` equal to `{ city: "KL" }`.
2. [unit] When no `toolcall_delta` event arrives and the `toolcall_end` event's `toolCall.arguments` is `{ city: "KL" }`, draining yields a `tool-call` event for t1 with `input` equal to `{ city: "KL" }`.
3. [unit] (control) When `toolcall_delta` events carry `{"city":"KL"}` and `toolCall.arguments` is `{ city: "KL" }`, draining yields a `tool-call` event for t1 with `input` equal to `{ city: "KL" }`.
4. [unit] When `toolcall_delta` events carry `{"city":"SG"}` and the `toolcall_end` event's `toolCall` has `arguments` `{}` and `argumentsError` set, draining yields a `tool-call` event for t1 with `input` equal to `{ city: "SG" }`.
5. [unit] (control) When `toolcall_delta` events carry `{"city"` and `toolCall.arguments` is `{ city: "KL" }`, draining ends with an `error` event of kind `bad-request` and message `Tool "lookup" returned unparseable arguments.`
6. [unit] (control) In that malformed case, draining yields no `tool-call` event.
7. [integration] Through the real-pi client, with `fetch` stubbed to stream `response.output_item.added` for function call `fc_1` (call id `c1`, name `lookup`) with empty arguments, then `response.output_item.done` for that call with arguments `{"city":"KL"}`, then `response.completed` whose `response.output` holds that completed call, `client.complete` resolves with `toolCalls[0].input` equal to `{ city: "KL" }`.
8. [integration] Through the real-pi client, with `fetch` stubbed to stream the same call with an argument delta `{"city":"SG"}`, then `response.output_item.done` with arguments `{"city":"KL"}`, then `response.completed` holding the completed call, `client.complete` resolves with `toolCalls[0].input` equal to `{ city: "KL" }`.

### US-002

1. [unit] When a `thinking_end` event at content index 0 has text `hmm` and its partial's block has `thinkingSignature` `sig-early`, and the `done` message (a separate object) has a thinking block at content index 0 with `thinkingSignature` `sig-final`, draining yields exactly one `thinking` event, with block `{ text: "hmm", signature: "sig-final" }`.
2. [unit] When the scripted events are a `thinking_end` at content index 0, then `toolcall_delta` and `toolcall_end` for tool call t1 at content index 1, then `done`, the yielded event types end with `tool-call`, `thinking`, `usage`, `done`, in that order.
3. [unit] (control) When the partial's block at `thinking_end` has `thinkingSignature` `sig-early` and `redacted: false`, and the `done` message holds either no block or a `text` block at that content index, the `thinking` event's block is `{ text: "hmm", signature: "sig-early", redacted: false }`.
4. [unit] When the partial's block at `thinking_end` has `redacted: false` and no signature, and the `done` message's block at that index has `redacted: true` and `thinkingSignature` `opaque`, the `thinking` event's block is `{ text: "hmm", signature: "opaque", redacted: true }`.
5. [unit] When two `thinking_end` events arrive at content indexes 0 and 2 with texts `a` and `b`, draining yields two `thinking` events, with texts `a` then `b`.
6. [unit] When a `thinking_end` event is followed by a pi-ai `error` event with message `upstream failed`, draining yields the `thinking` event, with its `thinking_end` values, before the final `error` event.
7. [unit] When a `thinking_end` event is followed by the end of the scripted events with no terminal event, draining yields the `thinking` event with its `thinking_end` values.
8. [unit] When a `thinking_end` event is followed by a malformed tool call (delta `{"city"`) and then `done`, draining yields the `thinking` event before the `usage` event, and ends with the `bad-request` error.
9. [unit] When the scripted stream throws `new Error("socket reset")` after a `thinking_end` event, draining yields the `thinking` event before the final `error` event.
10. [unit] When the request's signal is already aborted and a `thinking_end` event is followed by a pi-ai `error` event with message `Request was aborted`, iterating the stream rejects with the signal's abort reason and yields no `thinking` event.
11. [integration] Through the real-pi client, when the first response streams `response.output_item.added` for reasoning item `rs_1`, then `response.output_item.done` for `rs_1` with a summary and no `encrypted_content`, then `response.completed` whose output holds `rs_1` with `encrypted_content` `opaque-fixture`, each event in its own macrotask, a second `client.complete` whose messages replay the first result's `thinking` on an assistant message sends a request body whose `store` is `false`.
12. [integration] In that two-request sequence, the second request body's `input` holds a reasoning item `rs_1` whose `encrypted_content` is `opaque-fixture`.
13. [integration] (control) Through the real-pi client, when the first response's `response.output_item.done` for reasoning item `rs_1` already carries `encrypted_content` `opaque-fixture`, a second `client.complete` that replays the first result's `thinking` sends a request whose reasoning item `rs_1` has `encrypted_content` `opaque-fixture`.

### US-003

1. [unit] With `globalThis.fetch` stubbed, after `observeErrorResponses(onResponse)` has been constructed, to return a 429 response with header `Retry-After: 41`, calling the wrapper resolves to that same `Response` object and calls `onResponse` once with `status` 429 and a headers record whose `retry-after` entry is `41`.
2. [unit] In that case the stub received exactly the URL and init object the wrapper was called with.
3. [unit] (control) With `globalThis.fetch` stubbed to return a 200 response, the wrapper resolves to that response and never calls `onResponse`.
4. [unit] With `globalThis.fetch` stubbed to reject with `new TypeError("network down")`, the wrapper rejects with that same error and never calls `onResponse`.
5. [integration] Through the real-pi client, when `fetch` returns HTTP 429 with header `Retry-After: 41` and a JSON error body, `client.complete` rejects with a `ProtocolStreamError` whose `protocolError` has `kind` `rate-limit`, `status` 429 and `retryAfter` 41.
6. [integration] Through the real-pi client, when `fetch` returns HTTP 503 with header `Retry-After: 41` and a JSON error body, `client.complete` rejects with a `ProtocolStreamError` whose `protocolError` has `kind` `overloaded`, `status` 503 and `retryAfter` 41.
7. [integration] (control) Through the real-pi client, when `fetch` returns HTTP 429 with no `Retry-After` header, `client.complete` rejects with a `ProtocolStreamError` whose `protocolError` has `status` 429 and no `retryAfter` property.
8. [integration] (control) Through the real-pi client, when `fetch` returns HTTP 200 with header `Retry-After: 41` and a stream whose only event is `response.failed` with error code `rate_limit`, `client.complete` rejects with a `ProtocolStreamError` whose `protocolError` has `kind` `rate-limit` and `retryAfter` 41.

### US-004

Each AC uses a fresh temp directory and `createFileCredentialStore({ path })` on a file inside it. "A version 2 file" is `{"version":2,"credentials":{"existing":{"kind":"api-key","key":"k"}}}`; "an array file" is `{"version":1,"credentials":[{"providerId":"existing","kind":"api-key","key":"k"}]}`.

1. [unit] `modify("new", ...)` on a version 2 file rejects with an error whose message contains `is not a version 1 credential store` and `Refusing to overwrite it`.
2. [unit] After that rejection, the file's bytes equal the bytes written before the call.
3. [unit] `modify("new", ...)` on an array file rejects with an error whose message contains `could not be parsed as a credential store`, and the file's bytes are unchanged.
4. [unit] `read("existing")` on a version 2 file rejects with the `is not a version 1 credential store` error.
5. [unit] `modify("new", ...)` on a file holding `{"version":1,"credentials":null}` rejects with the `could not be parsed as a credential store` error.
6. [unit] `modify("new", ...)` on a file holding `{"credentials":{}}` (no `version`) rejects with the `is not a version 1 credential store` error.
7. [unit] The rejection messages for the version 2 file and the array file do not include the stored key `k`.
8. [unit] (control) `modify("new", ...)` on a version 1 file with a credentials map holding `existing` resolves, and the file then holds both `existing` and `new` with `version` 1.
9. [unit] With `lockTimeoutMs: 20`, while a first `modify("a", ...)` holds the lock and releases it 80 ms after a second `modify("b", ...)` starts, the second call rejects with `Timed out waiting for the credential file lock`, and its callback never runs.
10. [unit] With `lockTimeoutMs: 200`, while a first `modify` holds the lock until the second call settles, the second `modify` rejects with `Timed out waiting for the credential file lock` less than 400 ms after it started.
11. [unit] (control) With `lockTimeoutMs: 1000`, when the first `modify` releases the lock 50 ms after a second `modify("b", ...)` starts, the second call resolves and the file then holds `b`.
12. [unit] (control) With no `lockTimeoutMs`, an uncontended `modify("a", ...)` resolves and the file holds `a`.

### US-005

`_catalogDeps.loadProviders` is stubbed to return one provider `p1` whose models are `m1` (protocol `openai-completions`, tools), `m2` (protocol `google-generative-ai`, tools), `m3` (protocol `anthropic-messages`, no tools) and `m4` (protocol `openai-responses`, tools).

1. [unit] `listCatalogModels(["p1"])` returns `["p1/m1", "p1/m4"]`.
2. [unit] When every model of `p1` uses protocol `google-generative-ai`, `listCatalogModels(["p1"])` returns `[]`.
3. [unit] (control) When `p1`'s models use protocols `openai-codex-responses` and `anthropic-messages`, both with tools, `listCatalogModels(["p1"])` returns both, in catalog order.
4. [unit] (control) When `_catalogDeps.loadProviders` rejects, `listCatalogModels(["p1"])` returns `[]`.
5. [unit] `chatModelChoices` given a config with no tiers and no overrides, `availableProviders` `["p1"]`, and the production `listCatalogModels` over the stubbed `p1` catalog above, returns `["p1/m1", "p1/m4"]`.
