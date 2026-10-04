# S3-3 — Streaming model calls and the `onTurnEvent` sink — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the native loop's round-trip model calls stream (`collectStream(tap(client.stream(...)))` in place of `client.complete(...)`), and add a per-turn event sink, `SendTurnOpts.onTurnEvent`. The sink carries text and thinking deltas, `stream_reset`, `tool_call`, `tool_result`, one `usage` per round trip, and `compaction`. nax sets no sink, and its results, activity events and transcripts stay unchanged.

**Architecture:**
- A new backend-neutral contract type `TurnEvent` (`session/turn-event.ts`) and an optional `SendTurnOpts.onTurnEvent`.
- The loop builds one `TurnEventEmitter` per turn (`native/session/turn-event-emitter.ts`). It is the only place that calls the embedder's sink: it contains a throwing or rejecting sink, redacts tool input, and caps and redacts the tool-result preview. Without a sink every method is a no-op, so nax does no extra work.
- The loop emits round-level events at sites it already owns: the per-attempt `request()` wrapper (`stream_reset`), the round-trip bookkeeping (`usage`), both compaction steps (`compaction`) and the tool batch (`tool_call`/`tool_result`).
- Deltas are the one thing only the adapter can see. `TurnDeps.complete` gains an optional fourth argument, a delta sink the loop has already stamped with the round, and the adapter's `complete` closure passes it to a small `streamComplete` helper (`native/stream-complete.ts`). That helper calls `client.stream()` and folds the events with nax-ai's own `collectStream`.

**Tech Stack:** TypeScript 7.0.2, Bun 1.4 (bun:test), vitest on Node 22/24 for the Node contract suite, `@nathapp/nax-ai@0.1.16` (pinned; `collectStream`, `ProtocolStreamError` and `ProtocolEvent` are already exported, so no nax-ai release is needed).

**Spec:** `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`. The relevant sections are §5.3 (streaming model calls, R7), §5.4 (richer turn events), §4.4 (event payloads the facade will build from these), §8 (tests) and §9 row S3-3 and §10.3 (acceptance).

**Base:** `main` @ `15ccc2414` (S3-2 merged, #2344). Branch `feat/s3-3-streaming`. One PR.

## Global Constraints

- nax-visible behaviour is unchanged. With no `onTurnEvent`, `TurnResult`, the `onStreamActivity` event sequence (stream-bus events), transcript bytes, cost rows and tool-audit records are identical to `main`. The wire path is unchanged: nax-ai's `complete()` already was `collectStream(streamFrom(...))`; this PR calls the same `stream()` and the same `collectStream`.
- The fold is not reimplemented. `collectStream` encodes last-usage-wins, a required `done` event and `ProtocolStreamError` on an `error` event. The retry classifiers (`turn-retry.ts`, `turn-complete-step.ts` `isContextOverflow`) depend on exactly those throws.
- The compaction `summarize` closure keeps `client.complete()`. Summaries are not shown to a person (spec §5.3).
- `client.stream()` throws synchronously on header or session-id validation (`nax-ai/src/client.ts:150-153`). It must be called inside an `async` function, so the throw becomes a rejection exactly as `complete()`'s does.
- A throwing or rejecting sink can never break a model call, a tool call or a turn (spec §5.3: "a throwing sink cannot break the call").
- Dependency direction is `nax-ai` → `nax-agent` → `nax`. `@nathapp/nax-ai` is importable in nax-agent only from `src/native/` and `src/cost/standard-types.ts` (`check:nax-ai-imports`). `src/session/turn-event.ts` therefore must not import nax-ai.
- nax-agent ships zero Bun APIs (`check:no-bun-apis`); `src/` uses `node:` built-ins only.
- Every thrown error is a `NaxError` (`check-nax-error`). This PR adds no throw sites.
- No `_` names on `.`; `/internal` is unstable. This PR adds two type names to `.` (`TurnEvent`, `TurnEventSink`, Task 1) and two to `./internal` (`StreamDelta`, `StreamDeltaSink`, Task 3: `src/internal.ts:77` does `export * from "#src/native/session/turn-types"`). Run `bun run check:api`, then `bun run api:update`, and commit the snapshot. Additions only.
- nax-agent coverage: 80% overall and per file, empty baseline (`bun run test:coverage`).
- Never run bare `bun test` or `bun run nax`. Run package scripts from the package directory (`cd packages/nax-agent`, `cd packages/nax`).
- No emojis. Source files stay under 600 lines and test files under 800 (`check-file-sizes`). `turn-tool-batch.test.ts` is already long: put new batch tests in a new file.
- Complexity ratchet (`check-complexity`, limit 20, in `lint:checks`). Hot spots in this PR: `runToolBatch` (baselined at 59, may not grow) and `sendTurn` (baselined at 21, may not grow). Unbaselined but near the limit: `runModelRoundTrip` (18) and the adapter's `complete` closure (19); add no branch to them either. Add NO branch, ternary, `??`, `&&`/`||` or optional call (`?.(`) to either function. The emitter methods take the raw values and do the branching themselves. Run `bun ../repo-tooling/scripts/check-complexity.ts --package=.` after every task that touches `src/native/`.
- Test escape-hatch ratchet: the regex `\bas\s+[A-Z]\w*` counts test text, test names included, as a loose cast. Use typed declarations (`const sink: TurnEventSink = ...`), and keep test names clear of "as <Capitalised>". `as const` is fine.
- Test satellites gate: do not name test files after stories (`us-00x`).
- Tests do not sleep. A test that needs a macrotask turn uses `await new Promise((resolve) => setImmediate(resolve))`.
- macOS (BSD) tools: `sed -i ''`. Use a `for` loop over `grep -rl` output instead of piping into `xargs`.
- Conventional commit messages (`feat:`, `refactor:`, `test:`).

## Review Focus

1. **A sink that throws, or an `async` sink that rejects.** An embedder will write `onTurnEvent: async (e) => channel.push(e)`; TypeScript accepts an async function where `=> void` is expected. Expected: the turn's `TurnResult`, transcript and later events are unaffected, the next event still reaches the sink, and a rejection never becomes an unhandled rejection (which ends a Node process by default). Pinned in Task 1.
2. **A stream that fails after it has already emitted deltas, then a loop-level transport retry.** Expected: the failing attempt's `text_delta`s, then `stream_reset { round: 1, attempt: 2 }`, then the retry's deltas, then one `usage` for round 1. `TurnResult.output` is the retry's text only. Pinned in Task 4.
3. **A tool result that contains a credential and is larger than the preview cap, in multi-byte text.** Expected: `tool_result.preview` has the secret masked, is at most `TOOL_RESULT_PREVIEW_BYTES` bytes, and contains no U+FFFD (cut on a codepoint boundary). `tool_call.input` with a secret-named key (`apiKey`) is masked too. Pinned in Task 1.
4. **A provider stream that ends without a `done` event, or with an `error` event.** Expected: the round trip rejects exactly as it did through `complete()`: "Protocol stream ended without a done event" for the first, and nax-ai's own `ProtocolStreamError` (so `isProtocolStreamError`, the retry classifier and `toAdapterFailure` keep working) for the second. Pinned in Task 3.
5. **`client.stream()` throwing synchronously** (an invalid header or session id). Expected: `sendTurn` rejects; nothing throws synchronously out of the `complete` closure. Pinned in Task 3.

## Deviations from the spec (decided while planning)

- **`compaction.reason` is `"proactive" | "overflow"`.** The spec names the field and leaves the values open. These are the loop's own `before_compaction` reasons (`turn-compaction-step.ts:132,191`).
- **The compaction summary call emits no `usage` event.** Spec §4.4 says `usage` is "one per model call; marks the round's end" and carries `round`. A summary is not a round, has no round number and is not shown to the person. Its cost still reaches `TurnResult.tokenUsage` and `estimatedCostUsd` (and so the facade's `turn_end`) through the turn accumulator, as today.
- **`ask_human` calls emit no `tool_call` / `tool_result`.** The facade raises questions itself (spec §6.1, §5.4: "Questions and approvals do not go through the sink").
- **Calls the batch answers without running emit no tool events.** These are the spin-breaker `terminate` answers, the cancelled-turn synthetic answers, the invalid-call-budget halt and a throw from `before_tool` itself. A `tool_call` is emitted only once a call is going to be answered by a tool or by a `before_tool` `block`. Every emitted `tool_call` is followed by exactly one `tool_result` (the emitter enforces it).
- **Redaction and the preview cap are applied in the backend, at the sink.** The spec lists "(redacted)" and "(byte-capped, redacted)" on the facade's event table. Doing it at the emitter means no raw secret ever crosses the S1 contract, and the S4 acpx backend gets the same rule from the same helper. Redaction is nax-agent's existing `redactSecrets` (the logger's redactor). The cap is `TOOL_RESULT_PREVIEW_BYTES = 4096`; the spec gives no value.
- **`stream_reset` is emitted by the loop, not by the adapter's tap.** The loop's `request()` wrapper in `turn-complete-step.ts` already owns the per-round-trip attempt counter (`before_request` reports it). It emits `stream_reset` before every attempt after the first, which is the spec's rule ("on every request attempt after the first") at the one site that knows it.
- **The delta sink reaches the adapter as a fourth argument to `TurnDeps.complete`.** `CompleteCallOptions` is the loop-event bag that `before_request` handlers patch; a callback does not belong in it. The argument is optional, so the ~50 hand-written `complete` fakes in the loop tests keep compiling and simply never stream.
- **`TurnEvent` and `TurnEventSink` go on `.` now.** `SendTurnOpts` is already on `.`, and its new field names them. The facade's `SessionEvent` (S3-4) is a separate type.
- **Redaction is best-effort; previews and tool inputs must be treated as sensitive by an embedder.** `redactSecrets` masks secret-named keys in structured input and known token shapes and `KEY=value` assignments in text. It does NOT mask, for example, a JSON credential file's text (`{"client_secret": "..."}`) or `password: ...` lines, so a Read of a secret file outside the credential directory can surface in `tool_result.preview`. Task 1 pins this known gap so a later widening of the patterns (a separate PR: it changes logger output too) shows up as a deliberate test change. The `TurnEvent` doc says so.
- **Text and thinking deltas are not redacted.** A chunk cannot be redacted reliably (a secret can straddle chunks), and `TurnResult.output` and the transcript are not redacted either. Documented on `TurnEvent`.
- **`tool_call.input` is byte-capped too.** A `Write` carrying a multi-MB `content` must not cross the sink whole (the facade's channel caps events, not bytes). After redaction, an input whose JSON exceeds `TOOL_CALL_INPUT_BYTES = 8192` is replaced by `{ truncated: true, preview: <first 8192 bytes of the JSON> }`.
- **Redaction scans a bounded prefix.** With `deferModelTruncation`, a result can be up to `READ_CEILING` (2 MB) when no truncation handler ran. The preview is cut to `16 x TOOL_RESULT_PREVIEW_BYTES` before redaction, then to the cap after it, so a sink-enabled turn never runs the patterns over megabytes.
- **Tool-event pairing survives repeated ids and abnormal exits.** The emitter counts outstanding calls per id (a provider can repeat an id within a batch), and `runNativeTurn`'s catch block calls `flushUnanswered()`, which answers every still-outstanding `tool_call` with an error `tool_result` ("Not answered: the turn ended."), so the one-result-per-call rule holds even if the batch throws.
- **Facade notes carried to S3-4** (documented on `TurnEvent`): `stream_reset` voids everything since the failed attempt, including the backoff interval; `usage` events exclude the compaction summary, so turn totals come from `TurnResult`; `tool_result` has no `denied` flag (a refusal is a non-error result with refusal text); calls answered without running appear in the transcript with no tool events.
- **Test fakes derive `stream()` from `complete()`.** About 13 test files build fake nax-ai clients whose `stream` is an empty generator. Task 2 adds a helper that derives a working `stream()` from a fake's scripted `complete()`, so each fake's script stays the single source of its replies and counters on `complete` keep counting. The helper is a nax-agent test helper with a verbatim nax copy and a nax drift test (the S3-2 precedent, `nax/test/unit/agents/nax-owned-writes-copy.test.ts`).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/nax-agent/src/session/turn-event.ts` | Create | `TurnEvent` union and `TurnEventSink` (backend-neutral contract) |
| `packages/nax-agent/src/index.ts` | Modify | Export the two types on `.` |
| `packages/nax-agent/api/nax-agent.api.txt` | Modify | `api:update` (+2 names) |
| `packages/nax-agent/src/native/session/turn-event-emitter.ts` | Create | Safe sink wrapper, delta sink factory, tool-event pairing, redaction and preview cap, `usageEvent` |
| `packages/nax-agent/test/unit/native/session/turn-event-emitter.test.ts` | Create | Emitter unit tests (Review Focus 1, 3) |
| `packages/nax-agent/test/helpers/stream-from-complete.ts` | Create | `eventsFromResult`, `streamFromComplete`, `withDerivedStream` |
| `packages/nax-agent/test/helpers/index.ts` | Modify | Export the helper |
| `packages/nax-agent/test/unit/native/stream-from-complete-helper.test.ts` | Create | The helper folds back to the scripted result |
| `packages/nax/test/helpers/stream-from-complete.ts` | Create | Verbatim copy (first-line provenance note) |
| `packages/nax/test/helpers/index.ts` | Modify | Export the copy |
| `packages/nax/test/unit/agents/native/stream-from-complete-copy.test.ts` | Create | Drift guard |
| Fake-client test files (both packages, listed in Task 2) | Modify | Fakes get a working `stream()` |
| `packages/nax-agent/test/node/fixtures/packed-smoke.mjs` | Modify | Its fake yields real events (Task 2), and it asserts the sink (Task 6) |
| `packages/nax-agent/src/native/stream-complete.ts` | Create | `streamComplete(client, model, req, onDelta?)`: `client.stream` + tap + `collectStream` |
| `packages/nax-agent/test/unit/native/stream-complete.test.ts` | Create | Review Focus 4, 5 at the helper |
| `packages/nax-agent/src/native/session/turn-types.ts` | Modify | `StreamDelta`, `StreamDeltaSink`; `complete`'s 4th parameter; `TurnDeps.onTurnEvent` |
| `packages/nax-agent/src/native/session-adapter.ts` | Modify | Round-trip closure streams; `perTurnDeps` forwards `onTurnEvent` |
| `packages/nax-agent/test/unit/native/session-adapter-streaming.test.ts` | Create | Adapter-level pins: streams, summary stays `complete`, nax-visible output unchanged, sync throw |
| `packages/nax-agent/src/session/session-types.ts` | Modify | `SendTurnOpts.onTurnEvent` |
| `packages/nax-agent/src/native/session/turn-loop.ts` | Modify | Build the emitter; put it on `TurnRoundParams` |
| `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` | Modify | `usage` and proactive `compaction` events; thread the emitter |
| `packages/nax-agent/src/native/session/turn-complete-step.ts` | Modify | `stream_reset`, delta sink per attempt, overflow `compaction` |
| `packages/nax-agent/test/unit/native/session/turn-loop-turn-events.test.ts` | Create | Round-level events (Review Focus 2) |
| `packages/nax-agent/test/unit/native/session/loop-events/transform-context.test.ts` | Modify | Three direct `completeWithRecovery` calls pass `turnEvents` |
| `packages/nax-agent/src/native/session/turn-tool-batch.ts` | Modify | `tool_call` / `tool_result` |
| `packages/nax-agent/test/unit/native/session/turn-tool-batch.test.ts` | Modify | `batchArgs` default `turnEvents` |
| `packages/nax-agent/test/unit/native/session/turn-tool-batch-events.test.ts` | Create | Tool-event pairing and exclusions |
| `packages/nax-agent/test/unit/native/session-adapter-turn-events.test.ts` | Create | End to end through `NativeSessionAdapter.sendTurn` |

---

### Task 1: The `TurnEvent` contract and the turn-event emitter

**Files:**
- Create: `packages/nax-agent/src/session/turn-event.ts`
- Create: `packages/nax-agent/src/native/session/turn-event-emitter.ts`
- Modify: `packages/nax-agent/src/index.ts` (the `#src/session/session-types` export block, ~line 252)
- Modify: `packages/nax-agent/api/nax-agent.api.txt` (via `bun run api:update`)
- Test: `packages/nax-agent/test/unit/native/session/turn-event-emitter.test.ts`

**Interfaces:**
- Consumes: `redactSecrets` (`#src/internal/redact`), `isThenable` (`#src/internal/thenable`), `cutToByteCap` (`#src/tools/truncate`), `errorMessage` (`#src/infra/errors`), `getSafeLogger` (`#src/infra/index`), `cacheUsageFields` (`./turn-types.ts`), `ToolResultMessage` (`./tool-result.ts`), `ToolCall` (`@nathapp/nax-ai`), `TokenUsage` (`#src/cost/standard-types`).
- Produces:
  - `type TurnEvent` and `type TurnEventSink = (event: TurnEvent) => void` from `#src/session/turn-event` (and `.`).
  - `type StreamDelta = { readonly type: "text_delta" | "thinking_delta"; readonly text: string }` and `type StreamDeltaSink = (delta: StreamDelta) => void`, defined in `turn-event-emitter.ts` in this task and re-exported from `turn-types.ts` in Task 3.
  - `TOOL_RESULT_PREVIEW_BYTES = 4096`, `TOOL_CALL_INPUT_BYTES = 8192`.
  - `interface TurnEventEmitter { emit(event: TurnEvent): void; deltaSink(round: number): StreamDeltaSink | undefined; toolCall(call: ToolCall, recordedInput: unknown): void; toolResult(result: ToolResultMessage): void; flushUnanswered(): void }`.
  - `createTurnEventEmitter(sink: TurnEventSink | undefined): TurnEventEmitter`.
  - `usageEvent(round: number, usage: TokenUsage, costUsd: number): TurnEvent`.

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/native/session/turn-event-emitter.test.ts`:

```ts
/**
 * S3-3: the per-turn emitter is the only caller of an embedder's onTurnEvent
 * sink. It contains a throwing or rejecting sink, redacts tool input, and
 * caps and redacts the tool-result preview. Without a sink it does nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { buildToolResult } from "#src/native/session/tool-result";
import {
  createTurnEventEmitter,
  TOOL_CALL_INPUT_BYTES,
  TOOL_RESULT_PREVIEW_BYTES,
  usageEvent,
} from "#src/native/session/turn-event-emitter";
import type { TurnEvent, TurnEventSink } from "#src/session/turn-event";

const SECRET = "sk-abcdefghijklmnopqrstuvwx";

function collector(): { events: TurnEvent[]; sink: TurnEventSink } {
  const events: TurnEvent[] = [];
  return { events, sink: (event) => void events.push(event) };
}

const readCall = (id: string, input: unknown = { path: "a.ts" }) => ({ id, name: "Read", input });

describe("createTurnEventEmitter", () => {
  test("forwards events to the sink in order", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.emit({ type: "compaction", reason: "proactive" });
    emitter.emit({ type: "stream_reset", round: 1, attempt: 2 });
    expect(events).toEqual([
      { type: "compaction", reason: "proactive" },
      { type: "stream_reset", round: 1, attempt: 2 },
    ]);
  });

  test("deltaSink stamps the round on each delta", () => {
    const { events, sink } = collector();
    const onDelta = createTurnEventEmitter(sink).deltaSink(3);
    if (onDelta === undefined) throw new Error("expected a delta sink when a sink is set");
    onDelta({ type: "text_delta", text: "he" });
    onDelta({ type: "thinking_delta", text: "hm" });
    expect(events).toEqual([
      { type: "text_delta", round: 3, text: "he" },
      { type: "thinking_delta", round: 3, text: "hm" },
    ]);
  });

  test("without a sink: no delta sink, and every method is a no-op", () => {
    const emitter = createTurnEventEmitter(undefined);
    expect(emitter.deltaSink(1)).toBeUndefined();
    expect(() => {
      emitter.emit({ type: "compaction", reason: "overflow" });
      emitter.toolCall(readCall("c1"), undefined);
      emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "x" }));
      emitter.flushUnanswered();
    }).not.toThrow();
  });

  test("a throwing sink is contained and still receives the next event", () => {
    let calls = 0;
    const emitter = createTurnEventEmitter(() => {
      calls += 1;
      throw new Error("sink exploded");
    });
    emitter.emit({ type: "compaction", reason: "proactive" });
    emitter.emit({ type: "compaction", reason: "overflow" });
    expect(calls).toBe(2);
  });

  describe("an async sink that rejects", () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => void seen.push(reason);
    afterEach(() => {
      process.off("unhandledRejection", onUnhandled);
      seen.length = 0;
    });

    test("never surfaces an unhandled rejection", async () => {
      process.on("unhandledRejection", onUnhandled);
      const asyncSink: TurnEventSink = async () => {
        throw new Error("async sink exploded");
      };
      createTurnEventEmitter(asyncSink).emit({ type: "compaction", reason: "proactive" });
      createTurnEventEmitter(asyncSink).emit({ type: "compaction", reason: "overflow" });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toEqual([]);
    });
  });

  test("toolCall reports the recorded input when given, else the model's, redacted", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1", { path: "model.ts" }), { path: "rewritten.ts" });
    emitter.toolCall(readCall("c2", { command: `curl -H "x: ${SECRET}"`, apiKey: "plain" }), undefined);
    expect(events[0]).toEqual({ type: "tool_call", callId: "c1", name: "Read", input: { path: "rewritten.ts" } });
    const second = events[1];
    if (second?.type !== "tool_call") throw new Error("expected a tool_call");
    expect(JSON.stringify(second.input)).not.toContain(SECRET);
    expect(second.input).toHaveProperty("apiKey", "[REDACTED]");
  });

  test("a repeated call id is answered once per call", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("dup"), undefined);
    emitter.toolCall(readCall("dup"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "dup", content: "one" }));
    emitter.toolResult(buildToolResult({ toolCallId: "dup", content: "two" }));
    emitter.toolResult(buildToolResult({ toolCallId: "dup", content: "three" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_call", "tool_result", "tool_result"]);
  });

  test("flushUnanswered answers every outstanding call with an error result, then nothing", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolCall(readCall("c2"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "ok" }));
    emitter.flushUnanswered();
    emitter.flushUnanswered();
    expect(events.slice(3)).toEqual([
      { type: "tool_result", callId: "c2", isError: true, preview: "Not answered: the turn ended." },
    ]);
  });

  test("a tool_call input over the byte cap is replaced by a truncated JSON preview", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall({ id: "w1", name: "Write", input: { path: "big.txt", content: "x".repeat(50_000) } }, undefined);
    const event = events[0];
    if (event?.type !== "tool_call") throw new Error("expected a tool_call");
    expect(event.input).toHaveProperty("truncated", true);
    const preview = (event.input as { preview?: unknown }).preview;
    expect(typeof preview).toBe("string");
    expect(Buffer.byteLength(String(preview), "utf8")).toBeLessThanOrEqual(TOOL_CALL_INPUT_BYTES);
  });

  test("known gap (best-effort redaction): a JSON credential file's text is not masked", () => {
    // Pinned so widening SECRET_VALUE_PATTERNS later is a deliberate, visible change.
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: '{"client_secret": "plainvalue123"}' }));
    expect(events[1]).toHaveProperty("preview", '{"client_secret": "plainvalue123"}');
  });

  test("redaction scans a bounded prefix of a very large result", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: `${SECRET} ${"y".repeat(2_000_000)}` }));
    const result = events[1];
    if (result?.type !== "tool_result") throw new Error("expected a tool_result");
    expect(result.preview).not.toContain(SECRET);
    expect(Buffer.byteLength(result.preview, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_PREVIEW_BYTES);
  });

  test("toolResult reports only a call toolCall reported, and only once", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolResult(buildToolResult({ toolCallId: "never-called", content: "x" }));
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "body" }));
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "body again" }));
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    expect(events[1]).toEqual({ type: "tool_result", callId: "c1", isError: false, preview: "body" });
  });

  test("isError mirrors the result; a denial is not an error", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content: "boom", isError: true }));
    emitter.toolCall(readCall("c2"), undefined);
    emitter.toolResult(
      buildToolResult({ toolCallId: "c2", content: "refused", denied: { reason: "outside root", breach: false } }),
    );
    expect(events.filter((e) => e.type === "tool_result")).toEqual([
      { type: "tool_result", callId: "c1", isError: true, preview: "boom" },
      { type: "tool_result", callId: "c2", isError: false, preview: "refused" },
    ]);
  });

  test("the preview is redacted, then cut to the byte cap on a codepoint boundary", () => {
    const { events, sink } = collector();
    const emitter = createTurnEventEmitter(sink);
    // A secret up front, then 3-byte characters well past the cap.
    const content = `token ${SECRET} ${"\u20ac".repeat(3000)}`;
    emitter.toolCall(readCall("c1"), undefined);
    emitter.toolResult(buildToolResult({ toolCallId: "c1", content }));
    const result = events[1];
    if (result?.type !== "tool_result") throw new Error("expected a tool_result");
    expect(result.preview).not.toContain(SECRET);
    expect(Buffer.byteLength(result.preview, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_PREVIEW_BYTES);
    expect(result.preview).not.toContain("\uFFFD");
    expect(result.preview.length).toBeGreaterThan(1000);
  });
});

describe("usageEvent", () => {
  test("carries the round and cost; cache fields absent stay absent, zero stays zero", () => {
    expect(usageEvent(2, { inputTokens: 10, outputTokens: 5 }, 0.5)).toEqual({
      type: "usage",
      round: 2,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
    });
    expect(usageEvent(1, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 7 }, 0)).toEqual({
      type: "usage",
      round: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 7,
      costUsd: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-event-emitter.test.ts --timeout=60000`
Expected: FAIL, cannot resolve `#src/native/session/turn-event-emitter`.

- [ ] **Step 3: Write the contract type**

Create `packages/nax-agent/src/session/turn-event.ts`:

```ts
/**
 * Per-turn events a backend pushes to `SendTurnOpts.onTurnEvent` (S3 spec
 * 5.3, 5.4). Backend-neutral: the S3 facade adds `sessionId`, `turnId`, `at`
 * and `metadata` and turns these into its `SessionEvent`s. nax sets no sink.
 *
 * - Deltas are provisional. `after_response` handlers may patch the recorded
 *   text, so the transcript and `TurnResult.output` are authoritative.
 * - `stream_reset` voids the deltas of `round` so far: the round's request is
 *   being re-issued (a retry), and `attempt` is the new attempt's 1-based number.
 * - `usage` is one per round-trip model call and marks the round's end.
 * - `stream_reset` voids everything since the failed attempt began, including
 *   any retry backoff; the deltas after it are the new attempt's.
 * - `usage` excludes the compaction summary call, so a turn's totals come from
 *   `TurnResult` (`tokenUsage`, `estimatedCostUsd`), not from summing events.
 * - `tool_call.input` and `tool_result.preview` are redacted BEST-EFFORT (the
 *   logger's redactor: secret-named keys, known token shapes, KEY=value text)
 *   and byte-capped. A secret file's text can still appear; treat previews and
 *   inputs as sensitive. Text and thinking deltas are not redacted.
 * - Every `tool_call` is followed by exactly one `tool_result`, also when the
 *   turn throws. A refusal is a non-error result carrying the refusal text.
 *   Calls the loop answers without running (spin stop, cancel) and `ask_human`
 *   emit no tool events; they appear only in the transcript.
 */
export type TurnEvent =
  | { readonly type: "text_delta"; readonly round: number; readonly text: string }
  | { readonly type: "thinking_delta"; readonly round: number; readonly text: string }
  | { readonly type: "stream_reset"; readonly round: number; readonly attempt: number }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly callId: string; readonly isError: boolean; readonly preview: string }
  | {
      readonly type: "usage";
      readonly round: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** Absent when the call reported no cache data -- never coerced to 0. */
      readonly cacheRead?: number;
      /** Absent when the call reported no cache data -- never coerced to 0. */
      readonly cacheWrite?: number;
      readonly costUsd: number;
    }
  | { readonly type: "compaction"; readonly reason: "proactive" | "overflow" };

/** The per-turn sink. Called synchronously; a throw or a rejected promise is contained by the backend. */
export type TurnEventSink = (event: TurnEvent) => void;
```

- [ ] **Step 4: Write the emitter**

Create `packages/nax-agent/src/native/session/turn-event-emitter.ts`:

```ts
/**
 * The one caller of an embedder's `onTurnEvent` sink (S3-3).
 *
 * Built once per turn by `runNativeTurn`. Every method is a no-op without a
 * sink, so nax (which sets none) does no redaction or encoding work. The
 * emitter owns every branch the event sites would otherwise need, which keeps
 * `runToolBatch` and `sendTurn` free of new branches (complexity ratchet).
 *
 * - A sink that throws, or returns a promise that rejects, is contained and
 *   logged once per turn: an embedder's bug must not end a turn, a tool call
 *   or a Node process (an unhandled rejection does, by default).
 * - Tool input is redacted with the logger's redactor before it leaves; the
 *   result preview is redacted, then cut to `TOOL_RESULT_PREVIEW_BYTES` on a
 *   codepoint boundary. Redact first: cutting first could split a secret into
 *   a prefix the patterns no longer match.
 * - `toolResult` reports only a call `toolCall` reported (counted per id), and
 *   `flushUnanswered` answers what is left when a turn throws, so a consumer
 *   sees each `tool_call` answered by exactly one `tool_result`.
 * - Redaction is best-effort (see `TurnEvent`'s doc) and runs over a bounded
 *   prefix: a result can be up to 2 MB when no truncation handler ran.
 */

import type { ToolCall } from "@nathapp/nax-ai";
import type { TokenUsage } from "#src/cost/standard-types";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { redactSecrets } from "#src/internal/redact";
import { isThenable } from "#src/internal/thenable";
import type { TurnEvent, TurnEventSink } from "#src/session/turn-event";
import { cutToByteCap } from "#src/tools/truncate";
import type { ToolResultMessage } from "./tool-result.ts";
import { cacheUsageFields } from "./turn-types.ts";

/** Byte cap on `tool_result.preview`. A preview is for display; the transcript holds the full result. */
export const TOOL_RESULT_PREVIEW_BYTES = 4096;

/** Byte cap on `tool_call.input` as JSON; a larger input becomes `{ truncated: true, preview }`. */
export const TOOL_CALL_INPUT_BYTES = 8192;

/** Redaction scans at most this many bytes of a result; the preview keeps far fewer. */
const REDACTION_SCAN_BYTES = TOOL_RESULT_PREVIEW_BYTES * 16;

const UNANSWERED_PREVIEW = "Not answered: the turn ended.";

/** One streamed delta, before the loop stamps its round. */
export interface StreamDelta {
  readonly type: "text_delta" | "thinking_delta";
  readonly text: string;
}

export type StreamDeltaSink = (delta: StreamDelta) => void;

export interface TurnEventEmitter {
  emit(event: TurnEvent): void;
  /** A delta sink stamped with `round`; undefined without a sink, so the adapter's tap stays a pass-through. */
  deltaSink(round: number): StreamDeltaSink | undefined;
  /** `recordedInput` is a `before_tool` rewrite when there is one; otherwise the model's `call.input` is reported. */
  toolCall(call: ToolCall, recordedInput: unknown): void;
  toolResult(result: ToolResultMessage): void;
  /** Answers every outstanding `tool_call` with an error result. Called from the turn's catch block. */
  flushUnanswered(): void;
}

export function usageEvent(round: number, usage: TokenUsage, costUsd: number): TurnEvent {
  return {
    type: "usage",
    round,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...cacheUsageFields(usage),
    costUsd,
  };
}

function cappedInput(input: unknown): unknown {
  const redacted = redactSecrets(input);
  let json: string;
  try {
    json = JSON.stringify(redacted) ?? "null";
  } catch {
    return { truncated: true, preview: "[input not serializable]" };
  }
  if (Buffer.byteLength(json, "utf8") <= TOOL_CALL_INPUT_BYTES) return redacted;
  return { truncated: true, preview: cutToByteCap(json, TOOL_CALL_INPUT_BYTES) };
}

function previewOf(content: string): string {
  return cutToByteCap(redactSecrets(cutToByteCap(content, REDACTION_SCAN_BYTES)), TOOL_RESULT_PREVIEW_BYTES);
}

const NOOP_EMITTER: TurnEventEmitter = {
  emit: () => {},
  deltaSink: () => undefined,
  toolCall: () => {},
  toolResult: () => {},
  flushUnanswered: () => {},
};

export function createTurnEventEmitter(sink: TurnEventSink | undefined): TurnEventEmitter {
  if (sink === undefined) return NOOP_EMITTER;
  let warned = false;
  /** Outstanding tool calls per id: a provider can repeat an id within a batch. */
  const outstanding = new Map<string, number>();

  const contain = (event: TurnEvent, err: unknown): void => {
    if (warned) return;
    warned = true;
    try {
      getSafeLogger()?.warn("native-turn-events", "onTurnEvent sink failed; events are still delivered", {
        eventType: event.type,
        error: errorMessage(err),
      });
    } catch {
      // The containment path itself must never throw or reject.
    }
  };

  const emit = (event: TurnEvent): void => {
    try {
      const returned: unknown = sink(event);
      if (isThenable(returned)) returned.then(undefined, (err: unknown) => contain(event, err));
    } catch (err) {
      contain(event, err);
    }
  };

  return {
    emit,
    deltaSink: (round) => (delta) => emit({ ...delta, round }),
    toolCall(call, recordedInput) {
      outstanding.set(call.id, (outstanding.get(call.id) ?? 0) + 1);
      emit({ type: "tool_call", callId: call.id, name: call.name, input: cappedInput(recordedInput ?? call.input) });
    },
    toolResult(result) {
      const count = outstanding.get(result.toolCallId) ?? 0;
      if (count === 0) return;
      if (count === 1) outstanding.delete(result.toolCallId);
      else outstanding.set(result.toolCallId, count - 1);
      emit({
        type: "tool_result",
        callId: result.toolCallId,
        isError: result.isError === true,
        preview: previewOf(result.content),
      });
    },
    flushUnanswered() {
      for (const [callId, count] of outstanding) {
        for (let i = 0; i < count; i += 1) {
          emit({ type: "tool_result", callId, isError: true, preview: UNANSWERED_PREVIEW });
        }
      }
      outstanding.clear();
    },
  };
}
```

Check `#src/infra/errors` is the module that exports `errorMessage` (`grep -n "export function errorMessage" src/infra/errors.ts`). If `getSafeLogger` is exported from a narrower module than `#src/infra/index`, keep `#src/infra/index`: the other loop files use it.

- [ ] **Step 5: Export the contract on `.`**

In `packages/nax-agent/src/index.ts`, after the `#src/session/turn-deadline` export block (~line 272) and before the `adaptProviderTool` block (Biome `organizeImports` sorts by specifier), add:

```ts
export type { TurnEvent, TurnEventSink } from "#src/session/turn-event";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-event-emitter.test.ts --timeout=60000`
Expected: PASS (all tests).

- [ ] **Step 7: Update the API snapshot and run the gates**

Run: `cd packages/nax-agent && bun run check:api`
Expected: FAIL, listing exactly two additions under `[.]`, `type TurnEvent` and `type TurnEventSink` (the two `[./internal]` delta types arrive in Task 3, which reruns `api:update`).
Run: `bun run api:update && bun run check:api && bun run typecheck && bun run check:all`
Expected: all PASS. `git diff api/` shows two added lines and nothing removed. If Biome flags the async `asyncSink` test declaration (for example `nursery/noMisusedPromises`), add a targeted `// biome-ignore <rule>: the test needs an async sink that rejects` on that line; do not change the test.

- [ ] **Step 8: Commit**

```bash
git add packages/nax-agent/src/session/turn-event.ts packages/nax-agent/src/native/session/turn-event-emitter.ts packages/nax-agent/src/index.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test/unit/native/session/turn-event-emitter.test.ts
git commit -m "feat(nax-agent): TurnEvent contract and the per-turn event emitter"
```

---

### Task 2: Test fakes derive `stream()` from `complete()`

No source change. After this task every fake nax-ai client that a `sendTurn` can reach has a working `stream()` that replays its scripted `complete()`. The adapter still calls `complete()`, so every suite stays green; Task 3 then flips the adapter.

**Files:**
- Create: `packages/nax-agent/test/helpers/stream-from-complete.ts`
- Modify: `packages/nax-agent/test/helpers/index.ts`
- Create: `packages/nax-agent/test/unit/native/stream-from-complete-helper.test.ts`
- Create: `packages/nax/test/helpers/stream-from-complete.ts`
- Modify: `packages/nax/test/helpers/index.ts`
- Create: `packages/nax/test/unit/agents/native/stream-from-complete-copy.test.ts`
- Modify (fakes whose `stream` is an empty generator and that reach `sendTurn`):
  - `packages/nax-agent/test/unit/native/session-adapter.test.ts` (`countingClient`)
  - `packages/nax-agent/test/unit/native/session-adapter-client.test.ts`
  - `packages/nax-agent/test/unit/native/adapter-loop-handlers.test.ts` (`scriptedClient`)
  - `packages/nax-agent/test/unit/native/adapter-turn-signal.test.ts`
  - `packages/nax-agent/test/node/fixtures/packed-smoke.mjs`
  - `packages/nax/test/unit/agents/native/adapter.test.ts` (`fakeClient`)
  - `packages/nax/test/unit/agents/native/adapter-scope-id.test.ts`
  - `packages/nax/test/unit/agents/native/adapter-complete-rates.test.ts`
  - `packages/nax/test/unit/agents/native/adapter-auth-stamp-seam.test.ts`
  - `packages/nax/test/integration/plugins/loop-handler-delivery.test.ts`
  - Leave alone (they never reach `sendTurn`): `nax/test/unit/agents/native-agent/index.test.ts` (its `sendTurn` hits are a fake adapter), `nax-agent/test/unit/native/complete.test.ts`, `model-resolver.test.ts`, `client.test.ts`, `nax-agent/test/node/builtins.test.ts`, `nax/test/unit/agents/registry-native.test.ts`. The integration tests that build a real client against a local server (`adapter-auth-stamp.test.ts`, `credentials-source-chain.test.ts`, `credential-fault-classification.test.ts`) already stream on the wire and need nothing.

**Interfaces:**
- Consumes: nax-ai's `Client`, `ClientRequest`, `CompleteResult`, `ProtocolEvent`, `ResolvedModel`, `collectStream`.
- Produces (test helpers, both packages, same names):
  - `eventsFromResult(result: CompleteResult): ProtocolEvent[]`
  - `streamFromComplete(complete: Client["complete"]): Client["stream"]`
  - `withDerivedStream<C extends Client>(client: C): C`

- [ ] **Step 1: Write the failing helper test**

Create `packages/nax-agent/test/unit/native/stream-from-complete-helper.test.ts`:

```ts
/**
 * S3-3: fakes derive stream() from their scripted complete(). The events must
 * fold back, through nax-ai's own collectStream, to exactly the scripted result,
 * or every migrated fake would silently change what the loop sees.
 */
import { describe, expect, test } from "bun:test";
import { type Client, type CompleteResult, collectStream, type ResolvedModel } from "@nathapp/nax-ai";
import { streamFromComplete, withDerivedStream } from "#test/helpers/index";

const model: ResolvedModel = {
  id: "m",
  provider: "p",
  protocol: "openai-responses",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  supportsTools: true,
  thinkingLevels: [],
};

const results: Record<string, CompleteResult> = {
  textOnly: { text: "hello", usage: { inputTokens: 1, outputTokens: 2 }, stopReason: "stop" },
  empty: { text: "", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "stop" },
  full: {
    text: "calling",
    usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
    thinking: [{ text: "first" }, { text: "second", signature: "sig" }],
    responseId: "resp-1",
    responseModel: "m-2",
  },
};

describe("streamFromComplete", () => {
  test("empty toolCalls / thinking arrays fold to absent, as the real collectStream does", async () => {
    const stream = streamFromComplete(async () => ({ ...results.textOnly, toolCalls: [], thinking: [] }));
    const folded = await collectStream(stream(model, { messages: [] }));
    expect(folded).not.toHaveProperty("toolCalls");
    expect(folded).not.toHaveProperty("thinking");
  });

  for (const [name, result] of Object.entries(results)) {
    test(`folds back to the scripted result: ${name}`, async () => {
      const stream = streamFromComplete(async () => result);
      expect(await collectStream(stream(model, { messages: [] }))).toEqual(result);
    });
  }

  test("forwards the model and request to complete()", async () => {
    let seen: unknown;
    const stream = streamFromComplete(async (_m, req) => {
      seen = req;
      return results.textOnly;
    });
    await collectStream(stream(model, { messages: [], sessionId: "s1" }));
    expect(seen).toEqual({ messages: [], sessionId: "s1" });
  });

  test("a rejecting complete() rejects the fold with the same error object", async () => {
    const boom = new Error("upstream exploded");
    const stream = streamFromComplete(async () => {
      throw boom;
    });
    expect(await collectStream(stream(model, { messages: [] })).catch((e: unknown) => e)).toBe(boom);
  });
});

describe("withDerivedStream", () => {
  test("binds late: a stream call reaches the client's complete() at call time", async () => {
    let calls = 0;
    const client: Client = withDerivedStream({
      model: async () => model,
      listModels: async () => [model],
      pricing: () => model.pricing,
      stream: async function* stream() {},
      complete: async () => {
        calls += 1;
        return results.textOnly;
      },
      validate: () => {},
    });
    expect(await collectStream(client.stream(model, { messages: [] }))).toEqual(results.textOnly);
    expect(calls).toBe(1);
  });
});
```

If a `ResolvedModel` or `CompleteResult` field above does not exist in nax-ai 0.1.16 (check `packages/nax-ai/src/types.ts` and `protocols/types.ts`), drop that field; do not cast.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/stream-from-complete-helper.test.ts --timeout=60000`
Expected: FAIL, `streamFromComplete` is not exported from `#test/helpers/index`.

- [ ] **Step 3: Write the helper**

Create `packages/nax-agent/test/helpers/stream-from-complete.ts`:

```ts
/**
 * Derives a fake nax-ai client's `stream()` from its scripted `complete()` (S3-3).
 *
 * From S3-3 the native adapter's round trips stream, while most fakes script
 * `complete()`. Deriving one from the other keeps each fake's script the single
 * source of its replies, and a counter on `complete()` keeps counting. The
 * events fold back to exactly the scripted result through nax-ai's
 * `collectStream` (pinned by stream-from-complete-helper.test.ts).
 */
import type { Client, ClientRequest, CompleteResult, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";

export function eventsFromResult(result: CompleteResult): ProtocolEvent[] {
  const thinking = (result.thinking ?? []).flatMap((block): ProtocolEvent[] => [
    { type: "thinking-delta", text: block.text },
    { type: "thinking", block },
  ]);
  const text: ProtocolEvent[] = result.text.length > 0 ? [{ type: "text-delta", text: result.text }] : [];
  const calls = (result.toolCalls ?? []).map((call): ProtocolEvent => ({ type: "tool-call", call }));
  const done: ProtocolEvent = {
    type: "done",
    stopReason: result.stopReason,
    ...(result.responseId !== undefined ? { responseId: result.responseId } : {}),
    ...(result.responseModel !== undefined ? { responseModel: result.responseModel } : {}),
  };
  return [...thinking, ...text, ...calls, { type: "usage", usage: result.usage }, done];
}

export function streamFromComplete(complete: Client["complete"]): Client["stream"] {
  return async function* derivedStream(model: ResolvedModel, req: ClientRequest) {
    yield* eventsFromResult(await complete(model, req));
  };
}

/** Replaces `client.stream` with one derived from `client.complete`, looked up at call time. */
export function withDerivedStream<C extends Client>(client: C): C {
  return { ...client, stream: streamFromComplete((model, req) => client.complete(model, req)) };
}
```

Add to `packages/nax-agent/test/helpers/index.ts`, in sorted position between the `./session-sandbox-deps` and `./systemone-stub` exports:

```ts
export { eventsFromResult, streamFromComplete, withDerivedStream } from "./stream-from-complete";
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/native/stream-from-complete-helper.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Copy the helper into nax, with a drift guard**

Create `packages/nax/test/helpers/stream-from-complete.ts` as a byte-for-byte copy of the nax-agent file with one extra first line:

```ts
// Verbatim copy of nax-agent's test/helpers/stream-from-complete.ts (S3-3); stream-from-complete-copy.test.ts guards drift.
```

Add the same `export { eventsFromResult, streamFromComplete, withDerivedStream } from "./stream-from-complete";` line to `packages/nax/test/helpers/index.ts`, in its alphabetical position (match that barrel's existing specifier style).

Create `packages/nax/test/unit/agents/native/stream-from-complete-copy.test.ts`:

```ts
/**
 * nax's stream-from-complete test helper is a verbatim copy of nax-agent's
 * (S3-3): nax cannot import nax-agent's test helpers. This test fails when the
 * two drift. Import lines and the copy's one-line provenance header are the
 * only permitted differences.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const normalise = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("import ") && !line.startsWith("// Verbatim copy of nax-agent"))
    .join("\n")
    .trim();

describe("nax's stream-from-complete test helper", () => {
  test("is a verbatim copy of nax-agent's", () => {
    const original = readFileSync(
      join(import.meta.dir, "../../../../../nax-agent/test/helpers/stream-from-complete.ts"),
      "utf8",
    );
    const copy = readFileSync(join(import.meta.dir, "../../../helpers/stream-from-complete.ts"), "utf8");
    expect(normalise(copy)).toBe(normalise(original));
  });
});
```

Run: `cd packages/nax && bun test ./test/unit/agents/native/stream-from-complete-copy.test.ts --timeout=60000`
Expected: PASS. Then change one character in the copy, rerun, see it FAIL, and revert.

- [ ] **Step 6: Migrate every fake that reaches `sendTurn`**

For each file in this task's "Modify" list, give the fake a derived stream. Pick the form that fits the fake:

- A fake built by a factory that returns the client: wrap the finished object.

  ```ts
  // before
  const client: Client = { /* ... */ stream: async function* stream() {}, complete: /* ... */, validate: () => {} };
  return { client, completeCalls: () => calls };
  // after
  const client: Client = withDerivedStream({ /* ... */ stream: async function* stream() {}, complete: /* ... */, validate: () => {} });
  return { client, completeCalls: () => calls };
  ```

- A fake with `...over` overrides: wrap AFTER the spread, so an overridden `complete` is the one the stream replays (`withDerivedStream` looks `complete` up at call time).

  ```ts
  return withDerivedStream({ model: /* ... */, stream: async function* () {}, complete: /* ... */, validate: () => {}, ...over });
  ```

- A test that overrides `stream` on purpose (search the file for `stream:` before editing): leave that override as it is.

Import `withDerivedStream` from `#test/helpers/index` (nax-agent) or `@test/helpers` (nax).

`packages/nax-agent/test/node/fixtures/packed-smoke.mjs` is plain JS run against the packed tarball and cannot import test helpers. Replace its empty `stream` with a scripted one that yields the same result its `complete` returns:

```js
  stream: async function* () {
    yield { type: "text-delta", text: "packed-ok" };
    yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } };
    yield { type: "done", stopReason: "stop" };
  },
```

To find any fake the list missed:

```bash
cd packages
grep -rln "stream: async function\*" nax/test nax-agent/test
```

Every hit that also calls `sendTurn`, `sendPrompt` or `runAsSession` (or builds a `NativeAgentAdapter` / `NativeSessionAdapter` and sends a turn) must be migrated. `eventsFromResult` omits empty `toolCalls` / `thinking` arrays, as the real `collectStream` does; if a migrated fake returns `toolCalls: []` and a test asserts the transcript message carries `toolCalls: []`, that assertion described a shape a real provider can never produce: change it to the absent form and say so in the commit message.

- [ ] **Step 7: Run both suites**

Run: `cd packages/nax-agent && bun run test && bun run typecheck && bun run check:all`
Run: `cd packages/nax && bun run test && bun run typecheck && bun run check:all`
Run: `cd packages/nax-agent && bun run test:node`
Expected: all PASS (nothing reads `stream()` yet; this proves the migration compiles and changes nothing).

- [ ] **Step 8: Commit**

```bash
git add packages/nax-agent/test packages/nax/test
git commit -m "test: fake nax-ai clients derive stream() from their scripted complete()"
```

---

### Task 3: Round-trip model calls stream

**Files:**
- Create: `packages/nax-agent/src/native/stream-complete.ts`
- Modify: `packages/nax-agent/src/native/session/turn-types.ts` (`TurnDeps.complete`, ~line 62; re-export the delta types)
- Modify: `packages/nax-agent/src/native/session-adapter.ts` (the `complete` closure, lines 309-374)
- Test: `packages/nax-agent/test/unit/native/stream-complete.test.ts`
- Test: `packages/nax-agent/test/unit/native/session-adapter-streaming.test.ts`

**Interfaces:**
- Consumes: `StreamDelta`, `StreamDeltaSink` (Task 1, `./session/turn-event-emitter.ts`); nax-ai `Client`, `ClientRequest`, `CompleteResult`, `ProtocolEvent`, `ResolvedModel`, `collectStream`; `withDerivedStream`, `eventsFromResult` (Task 2, tests).
- Produces:
  - `streamComplete(client: Client, model: ResolvedModel, req: ClientRequest, onDelta?: StreamDeltaSink): Promise<CompleteResult>` from `#src/native/stream-complete`.
  - `TurnDeps.complete(messages, tools, options?, onDelta?: StreamDeltaSink): Promise<NativeTurnResponse>`.
  - `turn-types.ts` re-exports `StreamDelta` and `StreamDeltaSink`, so loop files import them from `./turn-types.ts`.

- [ ] **Step 1: Write the failing helper test**

Create `packages/nax-agent/test/unit/native/stream-complete.test.ts`:

```ts
/**
 * S3-3 (spec 5.3): round trips call client.stream() and fold with nax-ai's own
 * collectStream, tapping text and thinking deltas. The fold is nax-ai's, so a
 * missing done, an error event and a synchronous validation throw behave
 * exactly as they did through complete().
 */
import { describe, expect, test } from "bun:test";
import {
  type Client,
  type ClientRequest,
  type ProtocolEvent,
  ProtocolStreamError,
  type ResolvedModel,
} from "@nathapp/nax-ai";
import type { StreamDelta } from "#src/native/session/turn-types";
import { streamComplete } from "#src/native/stream-complete";

const model: ResolvedModel = {
  id: "m",
  provider: "p",
  protocol: "openai-responses",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  supportsTools: true,
  thinkingLevels: [],
};
const req: ClientRequest = { messages: [{ role: "user", content: "hi" }], sessionId: "s1" };

function clientStreaming(events: readonly ProtocolEvent[], seen?: { model?: unknown; req?: unknown }): Client {
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream(m, r) {
      if (seen !== undefined) {
        seen.model = m;
        seen.req = r;
      }
      return (async function* scripted() {
        yield* events;
      })();
    },
    complete: async () => {
      throw new Error("round trips must not call complete()");
    },
    validate: () => {},
  };
}

const script: ProtocolEvent[] = [
  { type: "thinking-delta", text: "hm" },
  { type: "thinking", block: { text: "hm" } },
  { type: "text-delta", text: "he" },
  { type: "tool-call-partial", id: "c1", name: "Read", rawInput: "{" },
  { type: "text-delta", text: "llo" },
  { type: "tool-call", call: { id: "c1", name: "Read", input: {} } },
  { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
  { type: "usage", usage: { inputTokens: 9, outputTokens: 4 } },
  { type: "done", stopReason: "tool_use" },
];

describe("streamComplete", () => {
  test("folds with collectStream: joined text, last usage wins, calls and thinking kept", async () => {
    const result = await streamComplete(clientStreaming(script), model, req);
    expect(result).toEqual({
      text: "hello",
      usage: { inputTokens: 9, outputTokens: 4 },
      stopReason: "tool_use",
      toolCalls: [{ id: "c1", name: "Read", input: {} }],
      thinking: [{ text: "hm" }],
    });
  });

  test("taps only text and thinking deltas, in stream order", async () => {
    const deltas: StreamDelta[] = [];
    await streamComplete(clientStreaming(script), model, req, (d) => void deltas.push(d));
    expect(deltas).toEqual([
      { type: "thinking_delta", text: "hm" },
      { type: "text_delta", text: "he" },
      { type: "text_delta", text: "llo" },
    ]);
  });

  test("passes the model and request through unchanged", async () => {
    const seen: { model?: unknown; req?: unknown } = {};
    await streamComplete(clientStreaming(script, seen), model, req);
    expect(seen.model).toBe(model);
    expect(seen.req).toBe(req);
  });

  test("a throwing delta sink cannot change the result", async () => {
    const result = await streamComplete(clientStreaming(script), model, req, () => {
      throw new Error("sink exploded");
    });
    expect(result.text).toBe("hello");
  });

  test("an error event rejects with nax-ai's own ProtocolStreamError", async () => {
    const failing: ProtocolEvent[] = [
      { type: "text-delta", text: "partial" },
      { type: "error", error: { kind: "transport", message: "upstream idle timeout" } },
    ];
    const err = await streamComplete(clientStreaming(failing), model, req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolStreamError);
    if (!(err instanceof ProtocolStreamError)) throw new Error("unreachable");
    expect(err.protocolError.kind).toBe("transport");
  });

  test("a stream without a done event rejects as truncated", async () => {
    const truncated: ProtocolEvent[] = [{ type: "text-delta", text: "cut" }];
    await expect(streamComplete(clientStreaming(truncated), model, req)).rejects.toThrow(
      "Protocol stream ended without a done event",
    );
  });

  test("a synchronous throw from stream() becomes a rejection", async () => {
    const client: Client = {
      ...clientStreaming(script),
      stream() {
        throw new Error("invalid header value");
      },
    };
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = streamComplete(client, model, req);
    }).not.toThrow();
    await expect(pending).rejects.toThrow("invalid header value");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/stream-complete.test.ts --timeout=60000`
Expected: FAIL, cannot resolve `#src/native/stream-complete` (and `StreamDelta` from `turn-types`).

- [ ] **Step 3: Write `streamComplete` and re-export the delta types**

Create `packages/nax-agent/src/native/stream-complete.ts`:

```ts
/**
 * One streamed model call (S3 spec 5.3, R7).
 *
 * nax-ai's `Client.complete()` is `collectStream(streamFrom(...))`, so the wire
 * was always a stream; this calls the same `stream()` and folds it with the
 * same `collectStream`, tapping text and thinking deltas on the way. The fold
 * is deliberately not reimplemented: last-usage-wins, the required `done` and
 * `ProtocolStreamError` on an `error` event are what the turn loop's retry and
 * overflow classifiers key on.
 *
 * `async` on purpose: `client.stream()` throws synchronously on an invalid
 * header or session id, and an async function turns that into a rejection,
 * exactly as `complete()` does. Without `onDelta` there is no tap at all.
 */

import { type Client, type ClientRequest, type CompleteResult, collectStream, type ProtocolEvent, type ResolvedModel } from "@nathapp/nax-ai";
import type { StreamDelta, StreamDeltaSink } from "./session/turn-types.ts";

function deltaOf(event: ProtocolEvent): StreamDelta | undefined {
  if (event.type === "text-delta") return { type: "text_delta", text: event.text };
  if (event.type === "thinking-delta") return { type: "thinking_delta", text: event.text };
  return undefined;
}

async function* tap(events: AsyncIterable<ProtocolEvent>, onDelta: StreamDeltaSink): AsyncIterable<ProtocolEvent> {
  for await (const event of events) {
    const delta = deltaOf(event);
    if (delta !== undefined) {
      try {
        onDelta(delta);
      } catch {
        // A display sink must not break the call; the emitter already logs its own failures.
      }
    }
    yield event;
  }
}

export async function streamComplete(
  client: Client,
  model: ResolvedModel,
  req: ClientRequest,
  onDelta?: StreamDeltaSink,
): Promise<CompleteResult> {
  const events = client.stream(model, req);
  return collectStream(onDelta === undefined ? events : tap(events, onDelta));
}
```

Run biome's formatter on it (`bun run lint:fix` in the package, or let `check:all` report the long import line) rather than hand-wrapping.

In `packages/nax-agent/src/native/session/turn-types.ts`:
- add `import type { StreamDeltaSink } from "./turn-event-emitter.ts";` and `export type { StreamDelta, StreamDeltaSink } from "./turn-event-emitter.ts";`
- change `TurnDeps.complete` to:

```ts
  /**
   * One round-trip model call. `onDelta` (S3-3) receives the call's text and
   * thinking deltas as they stream. The loop builds it per attempt from the
   * turn's emitter, already stamped with the round, and leaves it absent when
   * the turn has no `onTurnEvent` sink. Fakes may ignore it.
   */
  complete(
    messages: readonly ConversationMessage[],
    tools: ReturnType<typeof toToolDefinitions>,
    options?: CompleteCallOptions,
    onDelta?: StreamDeltaSink,
  ): Promise<NativeTurnResponse>;
```

Check for an import cycle: `turn-event-emitter.ts` imports `cacheUsageFields` (a value) from `turn-types.ts`, and `turn-types.ts` imports only types from `turn-event-emitter.ts`. Type-only edges are excluded from `check:import-cycles`; keep the `turn-types.ts` imports `import type` / `export type`.

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd packages/nax-agent && bun test ./test/unit/native/stream-complete.test.ts --timeout=60000`
Expected: PASS.

- [ ] **Step 5: Write the failing adapter test**

Create `packages/nax-agent/test/unit/native/session-adapter-streaming.test.ts`:

```ts
/**
 * S3-3 (spec 5.3) at the adapter: round trips stream, the compaction summary
 * stays complete(), and with no onTurnEvent sink nax-visible output (the
 * TurnResult and the stream-bus activity) is the same however the provider
 * chunks its reply.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStreamEvent, OpenSessionOpts, SessionModel, TurnResult } from "@nathapp/nax-agent";
import { _clientDeps, _resetNativeClient, saveTranscript } from "@nathapp/nax-agent/internal";
import type { Client, CompleteResult, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { eventsFromResult } from "#test/helpers/index";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const model: ResolvedModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};
const MODEL_DEF: SessionModel = { provider: "unknown", model: "openai/gpt-5.4-mini" };
const turn = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };
const REPLY: CompleteResult = { text: "hello world", usage: { inputTokens: 7, outputTokens: 3 }, stopReason: "stop" };

interface Counts {
  stream: number;
  complete: number;
}

/** Streams `events`; complete() answers only summaries. */
function streamingClient(events: () => readonly ProtocolEvent[], counts: Counts): Client {
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream() {
      counts.stream += 1;
      const scripted = events();
      return (async function* replay() {
        yield* scripted;
      })();
    },
    complete: async () => {
      counts.complete += 1;
      return { text: "summary", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
    },
    validate: () => {},
  };
}

async function open(adapter: NativeSessionAdapter, name: string, over: Partial<OpenSessionOpts> = {}) {
  const dir = await mkdtemp(join(tmpdir(), `nax-adapter-streaming-${name}-`));
  const activity: AgentStreamEvent[] = [];
  const handle = await adapter.openSession(name, {
    agentName: "native",
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: MODEL_DEF,
    timeoutSeconds: 60,
    transcriptDir: dir,
    onStreamActivity: (event) => void activity.push(event),
    ...over,
  });
  return { handle, dir, activity };
}

/** The activity sequence with the per-call ids and clock removed. */
function shape(activity: readonly AgentStreamEvent[]): unknown[] {
  return activity.map(({ callId: _c, timestamp: _t, ...rest }) => rest);
}

describe("NativeSessionAdapter round trips stream (S3-3)", () => {
  test("a round trip calls stream(), not complete()", async () => {
    const counts: Counts = { stream: 0, complete: 0 };
    _clientDeps.build = async () => streamingClient(() => eventsFromResult(REPLY), counts);
    const adapter = new NativeSessionAdapter();
    const { handle } = await open(adapter, "streams");
    const result = await adapter.sendTurn(handle, "hi", turn);
    expect(result.output).toBe("hello world");
    expect(counts).toEqual({ stream: 1, complete: 0 });
  });

  test("with no sink, chunking does not change the TurnResult or the stream-bus activity", async () => {
    const chunked: ProtocolEvent[] = [
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo " },
      { type: "text-delta", text: "world" },
      { type: "usage", usage: REPLY.usage },
      { type: "done", stopReason: "stop" },
    ];
    const runs: { result: TurnResult; activity: unknown[] }[] = [];
    for (const events of [eventsFromResult(REPLY), chunked]) {
      _resetNativeClient();
      _clientDeps.build = async () => streamingClient(() => events, { stream: 0, complete: 0 });
      // A fresh adapter per run, same session name: the activity carries sessionName.
      const adapter = new NativeSessionAdapter();
      const { handle, activity } = await open(adapter, "chunking");
      const result = await adapter.sendTurn(handle, "hi", turn);
      runs.push({ result, activity: shape(activity) });
    }
    expect(runs[1]).toEqual(runs[0]);
  });

  test("the compaction summary still calls complete()", async () => {
    const counts: Counts = { stream: 0, complete: 0 };
    _clientDeps.build = async () => streamingClient(() => eventsFromResult(REPLY), counts);
    const adapter = new NativeSessionAdapter();
    const { handle, dir } = await open(adapter, "summary", {
      modelDef: { ...MODEL_DEF, contextWindow: 8_000 },
      compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
    });
    await saveTranscript(dir, handle.id, [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(20_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(20_000) },
    ]);
    await adapter.sendTurn(handle, "next", turn);
    expect(counts).toEqual({ stream: 1, complete: 1 });
  });

  test("an error event mid-stream reaches the caller classified, as through complete()", async () => {
    const failing: ProtocolEvent[] = [
      { type: "text-delta", text: "partial" },
      { type: "error", error: { kind: "auth", message: "bad key" } },
    ];
    _clientDeps.build = async () => streamingClient(() => failing, { stream: 0, complete: 0 });
    const adapter = new NativeSessionAdapter();
    const { handle } = await open(adapter, "error-event");
    const err = await adapter.sendTurn(handle, "hi", turn).catch((e: unknown) => e);
    expect(err).toHaveProperty("adapterFailure");
    expect(err).toHaveProperty("message", "bad key");
  });

  test("a synchronous throw from stream() rejects sendTurn", async () => {
    _clientDeps.build = async () => ({
      ...streamingClient(() => [], { stream: 0, complete: 0 }),
      stream() {
        throw new Error("invalid header value");
      },
    });
    const adapter = new NativeSessionAdapter();
    const { handle } = await open(adapter, "sync-throw");
    await expect(adapter.sendTurn(handle, "hi", turn)).rejects.toThrow("invalid header value");
  });
});
```

`onStreamActivity` is an `OpenSessionOpts` field (`session-types.ts:137`), stored per session by `openNativeSession` (`session.ts:250-253`). `AgentStreamEvent` is on `.` (`api/nax-agent.api.txt:26`). If `TurnResult` carries a per-call random value (an id or timestamp), strip it before the comparison the way `shape()` strips the activity's `callId` and `timestamp`; do not loosen the comparison otherwise.

- [ ] **Step 6: Run the adapter test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session-adapter-streaming.test.ts --timeout=60000`
Expected: FAIL. "a round trip calls stream(), not complete()" sees `{ stream: 0, complete: 1 }` and the round trip gets "summary" text; the error-event and sync-throw tests fail because `stream()` is never called.

- [ ] **Step 7: Make the round-trip closure stream**

In `packages/nax-agent/src/native/session-adapter.ts`:
- import `streamComplete` from `./stream-complete.ts`;
- change the closure head from `complete: async (messages, tools, requestOptions) => {` to `complete: async (messages, tools, requestOptions, onDelta) => {`;
- replace `const res = await client.complete(resolved, {` (line 332) with `const res = await streamComplete(client, resolved, {`, and the call's closing `});` with `}, onDelta);`. The request object between them is unchanged.
- leave the `summarize` closure's `client.complete(...)` (line 297) as it is.
- update the file header comment (line 5) from "over complete()" to "over streamed model calls (`stream-complete.ts`; the compaction summary uses complete())".

This adds no branch to `sendTurn`.

- [ ] **Step 8: Run the tests and gates**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session-adapter-streaming.test.ts ./test/unit/native/stream-complete.test.ts --timeout=60000`
Expected: PASS.
Run: `cd packages/nax-agent && bun run check:api`
Expected: FAIL listing exactly two additions under `[./internal]`: `type StreamDelta` and `type StreamDeltaSink` (re-exported through `src/internal.ts:77`). Then `bun run api:update && bun run check:api`.
Run: `cd packages/nax-agent && bun run test && bun run typecheck && bun run check:all && bun run test:node`
Run: `cd packages/nax && bun run test && bun run typecheck && bun run check:all`
Expected: all PASS. A failure reading "Protocol stream ended without a done event" in a test that never set a stream is a fake Task 2 missed: migrate it (Task 2 Step 6) in this commit.
Run: `cd packages/nax-agent && bun ../repo-tooling/scripts/check-complexity.ts --package=.`
Expected: PASS with `sendTurn` still at 21.

- [ ] **Step 9: Commit**

```bash
git add packages/nax-agent/src/native/stream-complete.ts packages/nax-agent/src/native/session/turn-types.ts packages/nax-agent/src/native/session-adapter.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/test
git commit -m "feat(nax-agent): native round trips stream through collectStream (S3-3)"
```

---

### Task 4: The loop emits deltas, `stream_reset`, `usage` and `compaction`

**Files:**
- Modify: `packages/nax-agent/src/session/session-types.ts` (`SendTurnOpts`, after `turnId`, ~line 233)
- Modify: `packages/nax-agent/src/native/session/turn-types.ts` (`TurnDeps.onTurnEvent`)
- Modify: `packages/nax-agent/src/native/session-adapter.ts` (`loopHandlerDeps` becomes `perTurnDeps`, lines 63-76 and its call at 263)
- Modify: `packages/nax-agent/src/native/session/turn-loop.ts` (setup, `params`, ~line 169)
- Modify: `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` (`TurnRoundParams`, `maybeCompact`, `runModelRoundTrip`)
- Modify: `packages/nax-agent/src/native/session/turn-complete-step.ts` (`CompleteStepArgs`, `request()`, the overflow branch)
- Modify: `packages/nax-agent/test/unit/native/session/loop-events/transform-context.test.ts` (three `completeWithRecovery({...})` calls, lines ~154, ~188, ~237)
- Test: `packages/nax-agent/test/unit/native/session/turn-loop-turn-events.test.ts`

**Interfaces:**
- Consumes: `TurnEvent`, `TurnEventSink` (Task 1); `createTurnEventEmitter`, `usageEvent`, `TurnEventEmitter` (Task 1); `StreamDeltaSink` and `TurnDeps.complete`'s fourth argument (Task 3).
- Produces:
  - `SendTurnOpts.onTurnEvent?: TurnEventSink`
  - `TurnDeps.onTurnEvent?: TurnEventSink`
  - `TurnRoundParams.turnEvents: TurnEventEmitter` and `CompleteStepArgs.turnEvents: TurnEventEmitter` (required; Task 5 reads `params.turnEvents`).

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/native/session/turn-loop-turn-events.test.ts`:

```ts
/**
 * S3-3 (spec 5.3, 5.4): the loop's round-level turn events. Deltas carry the
 * round; a re-issued request voids the round's deltas with stream_reset; each
 * round trip ends with one usage event; compaction is reported with its reason.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { saveTranscript } from "#src/native/session/transcript-store";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { StreamDeltaSink, TurnDeps } from "#src/native/session/turn-types";
import type { SendTurnOpts } from "#src/session/session-types";
import type { TurnEvent } from "#src/session/turn-event";
import { cleanupTempDir, makeTempDir, seedNativeSession } from "#test/helpers/index";

let dir: string;
let sessionState: NativeSessionState;
const handle = { id: "sess-turn-events", agentName: "native" } as const;

beforeEach(() => {
  dir = makeTempDir("nax-turn-events-");
  sessionState = seedNativeSession(createNativeSessionState(), handle.id, { transcriptDir: dir });
});
afterEach(() => {
  cleanupTempDir(dir);
});

const reply = (over: Record<string, unknown> = {}) => ({
  text: "done",
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0,
  ...over,
});

function turnOpts(over: Partial<SendTurnOpts> = {}): SendTurnOpts {
  return {
    interactionHandler: { onInteraction: async () => ({ answer: "ok" }) },
    ...over,
  };
}

/** Builds deps whose `complete` streams `chunks` through the delta sink before resolving. */
function streamingDeps(events: TurnEvent[], over: Partial<TurnDeps> = {}): TurnDeps {
  return {
    sessionState,
    onTurnEvent: (e) => void events.push(e),
    complete: async (_m, _t, _o, onDelta?: StreamDeltaSink) => {
      onDelta?.({ type: "text_delta", text: "do" });
      onDelta?.({ type: "text_delta", text: "ne" });
      return reply();
    },
    ...over,
  };
}

class ProtocolStreamError extends Error {
  constructor(readonly protocolError: { kind: string; message: string }) {
    super(protocolError.message);
    this.name = "ProtocolStreamError";
  }
}

describe("runNativeTurn turn events (S3-3)", () => {
  test("deltas carry the round, and a usage event ends each round trip", async () => {
    const events: TurnEvent[] = [];
    let round = 0;
    await runNativeTurn(
      handle,
      "hi",
      turnOpts(),
      streamingDeps(events, {
        complete: async (_m, _t, _o, onDelta) => {
          round += 1;
          onDelta?.({ type: "text_delta", text: `r${round}` });
          return round === 1
            ? reply({ text: "r1", toolCalls: [{ id: "c1", name: "ctx", input: {} }], usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 } })
            : reply({ text: "r2", costUsd: 0.25 });
        },
      }),
    );
    expect(events.filter((e) => e.type !== "tool_call" && e.type !== "tool_result")).toEqual([
      { type: "text_delta", round: 1, text: "r1" },
      { type: "usage", round: 1, inputTokens: 5, outputTokens: 2, cacheRead: 3, costUsd: 0 },
      { type: "text_delta", round: 2, text: "r2" },
      { type: "usage", round: 2, inputTokens: 1, outputTokens: 1, costUsd: 0.25 },
    ]);
  });

  test("a transport retry after emitted deltas voids them with stream_reset", async () => {
    const events: TurnEvent[] = [];
    let attempt = 0;
    const result = await runNativeTurn(
      handle,
      "hi",
      turnOpts(),
      streamingDeps(events, {
        transportRetry: { maxAttempts: 3, baseDelayMs: 100 },
        sleep: async () => {},
        complete: async (_m, _t, _o, onDelta) => {
          attempt += 1;
          if (attempt === 1) {
            onDelta?.({ type: "text_delta", text: "stale" });
            throw new ProtocolStreamError({ kind: "transport", message: "upstream idle timeout" });
          }
          onDelta?.({ type: "text_delta", text: "fresh" });
          return reply({ text: "fresh" });
        },
      }),
    );
    expect(events).toEqual([
      { type: "text_delta", round: 1, text: "stale" },
      { type: "stream_reset", round: 1, attempt: 2 },
      { type: "text_delta", round: 1, text: "fresh" },
      { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    ]);
    expect(result.output).toBe("fresh");
  });

  test("proactive compaction is reported before the round's deltas, and the summary emits no usage", async () => {
    await saveTranscript(dir, handle.id, [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(20_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(20_000) },
    ]);
    const events: TurnEvent[] = [];
    await runNativeTurn(
      handle,
      "next",
      turnOpts(),
      streamingDeps(events, {
        contextWindow: 8000,
        compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
        summarize: async () => ({ text: "summary", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.01 }),
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["compaction", "text_delta", "text_delta", "usage"]);
    expect(events[0]).toEqual({ type: "compaction", reason: "proactive" });
  });

  test("an overflow is reported as compaction then stream_reset for the retried request", async () => {
    // ~2,000 tokens of history against a 4,000-token window: under the proactive
    // threshold (compactionThreshold: min(3600, 4000 - min(4096, 1000)) = 3000), but over the overflow keep budget
    // (keepBudget(4000, 30%, aggressive) = 600), so the overflow step has a span to summarize.
    await saveTranscript(dir, handle.id, [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(4_000) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(4_000) },
    ]);
    const events: TurnEvent[] = [];
    let attempt = 0;
    await runNativeTurn(
      handle,
      "next",
      turnOpts(),
      streamingDeps(events, {
        contextWindow: 4_000,
        compaction: { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 },
        summarize: async () => ({ text: "summary", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 }),
        complete: async () => {
          attempt += 1;
          if (attempt === 1) throw new ProtocolStreamError({ kind: "context-overflow", message: "too long" });
          return reply();
        },
      }),
    );
    expect(events).toEqual([
      { type: "compaction", reason: "overflow" },
      { type: "stream_reset", round: 1, attempt: 2 },
      { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    ]);
  });

  test("without a sink the loop hands complete() no delta sink", async () => {
    const seen: unknown[] = [];
    await runNativeTurn(handle, "hi", turnOpts(), {
      sessionState,
      complete: async (_m, _t, _o, onDelta) => {
        seen.push(onDelta);
        return reply();
      },
    });
    expect(seen).toEqual([undefined]);
  });
});
```

The first test's tool call names a context tool (`"ctx"`) that the turn does not advertise; the interaction handler answers it, which is enough for a second round trip. The filter drops the tool events Task 5 adds, so this test stays valid after Task 5.

The overflow test's numbers come from `keepBudget` (`compaction.ts:113`) and `estimateContextTokens`. If the estimate differs from ~2,000 tokens and either proactive compaction fires or the overflow step finds nothing to summarize (it then rethrows), adjust the two message lengths, not the expectation: the point is a provider-side overflow with no proactive compaction first.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-loop-turn-events.test.ts --timeout=60000`
Expected: FAIL, typecheck-level: `onTurnEvent` is not a `TurnDeps` field (bun runs it anyway and no events arrive, so the `toEqual` assertions fail).

- [ ] **Step 3: Add the contract fields**

In `packages/nax-agent/src/session/session-types.ts`, inside `SendTurnOpts` after `turnId?: string;`:

```ts
  /**
   * S3-3: per-turn event sink (deltas, stream_reset, tool calls and results,
   * per-round usage, compaction). Native honours it; ACP ignores it until S4.
   * Called synchronously; a throw or rejection is contained by the backend.
   * nax sets none.
   */
  onTurnEvent?: import("./turn-event.ts").TurnEventSink;
```

In `packages/nax-agent/src/native/session/turn-types.ts`, in `TurnDeps` after `loopHandlerContext`:

```ts
  /**
   * S3-3: the turn's event sink, forwarded from `SendTurnOpts`. `runNativeTurn`
   * wraps it once in a `TurnEventEmitter`; nothing else calls it.
   */
  onTurnEvent?: import("#src/session/turn-event").TurnEventSink;
```

- [ ] **Step 4: Forward it from the adapter**

In `packages/nax-agent/src/native/session-adapter.ts`, rename `loopHandlerDeps` to `perTurnDeps` and add the field (update its doc comment to say it carries the per-turn inputs the adapter forwards verbatim, and fix the call site at line 263):

```ts
function perTurnDeps(opts: SendTurnOpts): Pick<TurnDeps, "loopHandlers" | "loopHandlerContext" | "onTurnEvent"> {
  return {
    ...(opts.loopHandlers !== undefined ? { loopHandlers: opts.loopHandlers } : {}),
    ...(opts.loopHandlerContext !== undefined ? { loopHandlerContext: opts.loopHandlerContext } : {}),
    ...(opts.onTurnEvent !== undefined ? { onTurnEvent: opts.onTurnEvent } : {}),
  };
}
```

- [ ] **Step 5: Build the emitter and thread it**

In `turn-loop.ts`: import `createTurnEventEmitter` from `./turn-event-emitter.ts`; add `turnEvents: createTurnEventEmitter(deps.onTurnEvent),` to the `params: TurnRoundParams` literal (~line 169).

In `turn-loop-round-trip.ts`:
- import `type TurnEventEmitter, usageEvent` from `./turn-event-emitter.ts`;
- add to `TurnRoundParams`:

```ts
  /** S3-3: the turn's one event emitter (a no-op without an `onTurnEvent` sink). */
  turnEvents: TurnEventEmitter;
```

- in `maybeCompact`, inside the existing `if (step.compacted) {` block, after the two resets, add `params.turnEvents.emit({ type: "compaction", reason: "proactive" });`
- in `runModelRoundTrip`, pass `turnEvents: params.turnEvents,` into the `completeWithRecovery({...})` argument, and right after the existing `deps.onActivity?.(usageBeat(res.usage, res.costUsd, state.roundTrips));` add:

```ts
  params.turnEvents.emit(usageEvent(state.roundTrips, res.usage, res.costUsd));
```

In `turn-complete-step.ts`:
- import `type TurnEventEmitter` from `./turn-event-emitter.ts`;
- add to `CompleteStepArgs`:

```ts
  /** S3-3: the turn's event emitter. Emits stream_reset and the overflow compaction; hands the adapter a per-attempt delta sink. */
  readonly turnEvents: TurnEventEmitter;
```

- destructure `turnEvents` in `completeWithRecovery`;
- in `request()`, right after `attempt += 1;`:

```ts
    // Spec 5.3: every request attempt after the first voids the round's
    // deltas so far. nax-ai retries only before the first event, so any
    // re-issue with deltas already shown comes from here (transport retry or
    // the overflow retry).
    if (attempt > 1) turnEvents.emit({ type: "stream_reset", round: roundTrip, attempt });
```

- change `return deps.complete(wire.messages, tools, options);` to `return deps.complete(wire.messages, tools, options, turnEvents.deltaSink(roundTrip));`
- in the overflow branch, after `compacted = true;` add `turnEvents.emit({ type: "compaction", reason: "overflow" });`

In `test/unit/native/session/loop-events/transform-context.test.ts`, add `turnEvents: createTurnEventEmitter(undefined),` to each of the three `completeWithRecovery({...})` argument objects, importing `createTurnEventEmitter` from `#src/native/session/turn-event-emitter`.

- [ ] **Step 6: Run the tests and gates**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-loop-turn-events.test.ts --timeout=60000`
Expected: PASS.
Run: `cd packages/nax-agent && bun run test && bun run typecheck && bun run check:all && bun ../repo-tooling/scripts/check-complexity.ts --package=.`
Run: `cd packages/nax && bun run test && bun run typecheck`
Expected: all PASS; `sendTurn` still 21.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent/src packages/nax-agent/test
git commit -m "feat(nax-agent): native turns emit deltas, stream_reset, usage and compaction to onTurnEvent"
```

---

### Task 5: The tool batch emits `tool_call` and `tool_result`

**Files:**
- Modify: `packages/nax-agent/src/native/session/turn-tool-batch.ts` (`ToolBatchArgs`, `runToolBatch`)
- Modify: `packages/nax-agent/src/native/session/turn-loop-round-trip.ts` (`dispatchToolBatch` passes `turnEvents`)
- Modify: `packages/nax-agent/test/unit/native/session/turn-tool-batch.test.ts` (`batchArgs` default)
- Test: `packages/nax-agent/test/unit/native/session/turn-tool-batch-events.test.ts`

**Interfaces:**
- Consumes: `TurnEventEmitter.toolCall(call, recordedInput)` and `.toolResult(result)` (Task 1); `TurnRoundParams.turnEvents` (Task 4).
- Produces: `ToolBatchArgs.turnEvents: TurnEventEmitter` (required).

- [ ] **Step 1: Write the failing test**

Create `packages/nax-agent/test/unit/native/session/turn-tool-batch-events.test.ts`:

```ts
/**
 * S3-3 (spec 5.4): tool_call / tool_result from the batch. A tool_call goes out
 * once a call will be answered by a tool or by a before_tool block, with the
 * input the transcript records; each is answered by exactly one tool_result.
 * ask_human and the synthetic answers (terminate, cancel) emit nothing.
 */
import { describe, expect, test } from "bun:test";
import { ASK_HUMAN_TOOL_NAME } from "#src/native/session/ask-human";
import type { TranscriptMessage } from "#src/native/session/compaction";
import { createInvalidCallBudget } from "#src/native/session/handle-invalid-tool-call";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { createNativeSessionState } from "#src/native/session/session";
import { codingToolsToDefinitions } from "#src/native/session/tool-mapping";
import { createTurnEventEmitter } from "#src/native/session/turn-event-emitter";
import { runToolBatch, type ToolBatchArgs } from "#src/native/session/turn-tool-batch";
import type { TurnDeps } from "#src/native/session/turn-types";
import type { SendTurnOpts } from "#src/session/session-types";
import type { TurnEvent } from "#src/session/turn-event";
import type { CodingTool } from "#src/tools/index";

const sessionState = createNativeSessionState();
const deps: TurnDeps = { sessionState, complete: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 }) };

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "raw-body" };
  },
};

const call = (id: string, path: string) => ({ id, name: fakeRead.name, input: { path } });

function args(events: TurnEvent[], over: Partial<ToolBatchArgs> & { opts: SendTurnOpts }): ToolBatchArgs {
  const toolCalls = over.toolCalls ?? [call("c1", "a.ts"), call("c2", "b.ts")];
  const messages: TranscriptMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [...toolCalls] },
  ];
  return {
    messages,
    toolCalls,
    tools: codingToolsToDefinitions([fakeRead]),
    codingToolNames: new Set([fakeRead.name]),
    roundTrips: 1,
    deps,
    loopEvents: createLoopEventRegistry(),
    invalidCallBudget: createInvalidCallBudget(),
    spinBreaker: undefined,
    maxInteractions: 0,
    spinWarned: false,
    interactionsSoFar: 0,
    turnEvents: createTurnEventEmitter((e) => void events.push(e)),
    ...over,
  };
}

const answering = (answer: string): SendTurnOpts => ({
  interactionHandler: { onInteraction: async () => ({ answer }) },
});

describe("runToolBatch tool events (S3-3)", () => {
  test("each executed call: tool_call before it runs, then its tool_result", async () => {
    const events: TurnEvent[] = [];
    const order: string[] = [];
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async (req) => {
          order.push(`run:${events.length}`);
          const input = req.kind === "coding-tool" ? req.input : undefined;
          return { answer: `body of ${String(input?.path)}` };
        },
      },
    };
    await runToolBatch(args(events, { opts }));
    expect(order).toEqual(["run:1", "run:3"]);
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: false, preview: "body of a.ts" },
      { type: "tool_call", callId: "c2", name: "Read", input: { path: "b.ts" } },
      { type: "tool_result", callId: "c2", isError: false, preview: "body of b.ts" },
    ]);
  });

  test("the reported input is the before_tool rewrite the transcript records", async () => {
    const events: TurnEvent[] = [];
    const loopEvents = createLoopEventRegistry();
    loopEvents.register("before_tool", async () => ({ kind: "allow", input: { path: "fixed.ts" } }));
    await runToolBatch(args(events, { opts: answering("ok"), toolCalls: [call("c1", "a.ts")], loopEvents }));
    expect(events[0]).toEqual({ type: "tool_call", callId: "c1", name: "Read", input: { path: "fixed.ts" } });
  });

  test("a before_tool block is a call answered on the tool's behalf", async () => {
    const events: TurnEvent[] = [];
    const loopEvents = createLoopEventRegistry();
    loopEvents.register("before_tool", async () => ({ kind: "block", content: "blocked: bad input", isError: true }));
    await runToolBatch(args(events, { opts: answering("never"), toolCalls: [call("c1", "a.ts")], loopEvents }));
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: true, preview: "blocked: bad input" },
    ]);
  });

  test("a tool that throws is reported as an error result", async () => {
    const events: TurnEvent[] = [];
    const opts: SendTurnOpts = {
      interactionHandler: {
        onInteraction: async () => {
          throw new Error("disk on fire");
        },
      },
    };
    await runToolBatch(args(events, { opts, toolCalls: [call("c1", "a.ts")] }));
    expect(events).toEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: true, preview: "disk on fire" },
    ]);
  });

  test("calls answered without running emit nothing: terminate and cancel", async () => {
    const terminated: TurnEvent[] = [];
    const terminating = createLoopEventRegistry();
    terminating.register("before_tool", async () => ({ kind: "terminate", content: "spin", isError: true }));
    await runToolBatch(args(terminated, { opts: answering("never"), loopEvents: terminating }));
    expect(terminated).toEqual([]);

    const cancelled: TurnEvent[] = [];
    const controller = new AbortController();
    controller.abort("stop");
    await runToolBatch(args(cancelled, { opts: answering("never"), deps: { ...deps, signal: controller.signal } }));
    expect(cancelled).toEqual([]);
  });

  test("ask_human emits no tool events", async () => {
    const events: TurnEvent[] = [];
    await runToolBatch(
      args(events, {
        opts: answering("yes"),
        maxInteractions: 1,
        toolCalls: [{ id: "q1", name: ASK_HUMAN_TOOL_NAME, input: { text: "proceed?" } }],
      }),
    );
    expect(events).toEqual([]);
  });
});
```

The `before_tool` outcomes match `src/native/session/loop-events/types.ts:54-57`. `AdapterInteraction` is a union (`src/session/interaction-handler.ts:3-33`) whose `question` variant has no `input`, hence the `kind` narrowing in the first test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-tool-batch-events.test.ts --timeout=60000`
Expected: FAIL; the batch emits no events (and `turnEvents` is not yet a `ToolBatchArgs` field).

- [ ] **Step 3: Emit from the batch, adding no branch**

In `turn-tool-batch.ts`:
- import `type TurnEventEmitter` from `./turn-event-emitter.ts`;
- add to `ToolBatchArgs`:

```ts
  /** S3-3: the turn's event emitter; reports each answered call (no-op without a sink). */
  readonly turnEvents: TurnEventEmitter;
```

- destructure `turnEvents` in `runToolBatch`;
- the `block` branch (line ~185) becomes:

```ts
      if (outcome.kind === "block") {
        if (outcome.input !== undefined) messages = rewriteToolCallInput(messages, call.id, outcome.input);
        turnEvents.toolCall(call, outcome.input);
        const blocked = buildToolResult({ toolCallId: call.id, content: outcome.content, isError: outcome.isError });
        messages.push(blocked);
        turnEvents.toolResult(blocked);
        continue;
      }
```

  (keep the two existing comment lines above `if (outcome.input ...)`)
- right before `const answer = await opts.interactionHandler.onInteraction(` add `turnEvents.toolCall(call, rewritten);`
- the genuine-result push (line ~277) becomes:

```ts
      const result = buildToolResult({
        toolCallId: call.id,
        content: finalContent,
        isError: patch.isError,
        denied: answer?.denied,
      });
      messages.push(result);
      turnEvents.toolResult(result);
```

- the catch-block push (line ~302) becomes:

```ts
      const failed = buildToolResult({
        toolCallId: call.id,
        content: patch.content ?? errorText,
        isError: patch.isError ?? true,
      });
      messages.push(failed);
      turnEvents.toolResult(failed);
```

  (`toolResult` is a no-op when the throw came from `before_tool`, before any `toolCall`.)

Do NOT touch the `ask_human`, `terminate` or `answerCancelledFrom` paths.

In `turn-loop-round-trip.ts` `dispatchToolBatch`, add `turnEvents: params.turnEvents,` to the `runToolBatch({...})` argument.

In `turn-loop.ts`, make the first statement of the `catch (err) {` block that follows the outer `while (true)` loop (~line 218):

```ts
    // S3-3: a throw can leave a reported tool_call unanswered; answer it so the
    // sink's one-result-per-call rule holds on every ending.
    params.turnEvents.flushUnanswered();
```

(`runNativeTurn` is not baselined; this adds no branch.)

In `turn-tool-batch.test.ts` `batchArgs`, add `turnEvents: createTurnEventEmitter(undefined),` before `...over`, importing `createTurnEventEmitter` from `#src/native/session/turn-event-emitter`.

- [ ] **Step 4: Run the tests and gates**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session/turn-tool-batch-events.test.ts ./test/unit/native/session/turn-tool-batch.test.ts ./test/unit/native/session/turn-loop-turn-events.test.ts --timeout=60000`
Expected: PASS.
Run: `cd packages/nax-agent && bun ../repo-tooling/scripts/check-complexity.ts --package=.`
Expected: PASS with `runToolBatch` at 59 or lower. If it reports a LOWER score, run `--update-baseline` and include the lowered baseline in the commit. If it reports a higher one, a branch slipped in: move it into the emitter.
Run: `cd packages/nax-agent && bun run test && bun run typecheck && bun run check:all`
Run: `cd packages/nax && bun run test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/native/session packages/nax-agent/test packages/nax-agent/scripts/baselines
git commit -m "feat(nax-agent): native tool batch reports tool_call and tool_result to onTurnEvent"
```

---

### Task 6: End to end through the adapter, and on Node

**Files:**
- Test: `packages/nax-agent/test/unit/native/session-adapter-turn-events.test.ts`
- Modify: `packages/nax-agent/test/node/fixtures/packed-smoke.mjs`

**Interfaces:**
- Consumes: everything above, through the public `NativeSessionAdapter.sendTurn(handle, prompt, { onTurnEvent })`.
- Produces: nothing new.

- [ ] **Step 1: Write the end-to-end test**

Create `packages/nax-agent/test/unit/native/session-adapter-turn-events.test.ts` (test files do not import each other, so the fixtures are written out here):

```ts
/**
 * S3-3: onTurnEvent end to end through NativeSessionAdapter.sendTurn, and the
 * sink is invisible to nax: with no sink, a collecting sink, a throwing sink or
 * an async sink that rejects, the TurnResult, the saved transcript and the
 * stream-bus activity are identical (spec 8: behaviour-neutral pins).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentStreamEvent,
  CodingTool,
  SendTurnOpts,
  SessionModel,
  TurnEvent,
  TurnEventSink,
  TurnResult,
} from "@nathapp/nax-agent";
import { _clientDeps, _resetNativeClient, loadTranscript } from "@nathapp/nax-agent/internal";
import type { Client, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";
import { NativeSessionAdapter } from "#src/native/session-adapter";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const model: ResolvedModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};
const MODEL_DEF: SessionModel = { provider: "unknown", model: "openai/gpt-5.4-mini" };

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "never run: the interaction handler answers" };
  },
};

const ROUND_1: ProtocolEvent[] = [
  { type: "text-delta", text: "Let me look" },
  { type: "tool-call", call: { id: "c1", name: "Read", input: { path: "a.ts" } } },
  { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
  { type: "done", stopReason: "tool_use" },
];
const ROUND_2: ProtocolEvent[] = [
  { type: "text-delta", text: "done" },
  { type: "usage", usage: { inputTokens: 6, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

function scriptedClient(): Client {
  let calls = 0;
  return {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => model.pricing,
    stream() {
      calls += 1;
      const events = calls === 1 ? ROUND_1 : ROUND_2;
      return (async function* replay() {
        yield* events;
      })();
    },
    complete: async () => {
      throw new Error("round trips must stream");
    },
    validate: () => {},
  };
}

interface Run {
  readonly result: TurnResult;
  readonly transcript: unknown;
  readonly activity: unknown[];
}

async function runTurn(onTurnEvent?: TurnEventSink): Promise<Run> {
  _resetNativeClient();
  _clientDeps.build = async () => scriptedClient();
  const adapter = new NativeSessionAdapter();
  const dir = await mkdtemp(join(tmpdir(), "nax-adapter-turn-events-"));
  const activity: AgentStreamEvent[] = [];
  const handle = await adapter.openSession("turn-events", {
    agentName: "native",
    workdir: dir,
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: MODEL_DEF,
    timeoutSeconds: 60,
    transcriptDir: dir,
    onStreamActivity: (event) => void activity.push(event),
  });
  const opts: SendTurnOpts = {
    // Coding-tool calls reach the handler as kind "coding-tool"; its answer is the tool result.
    interactionHandler: { onInteraction: async () => ({ answer: "contents" }) },
    codingTools: [fakeRead],
    ...(onTurnEvent !== undefined ? { onTurnEvent } : {}),
  };
  const result = await adapter.sendTurn(handle, "read a.ts", opts);
  return {
    result,
    transcript: await loadTranscript(dir, handle.id),
    activity: activity.map(({ callId: _c, timestamp: _t, ...rest }) => rest),
  };
}

describe("NativeSessionAdapter.sendTurn onTurnEvent (S3-3)", () => {
  test("streams the turn's events in order", async () => {
    const events: TurnEvent[] = [];
    const { result } = await runTurn((e) => void events.push(e));
    expect(events).toEqual([
      { type: "text_delta", round: 1, text: "Let me look" },
      { type: "usage", round: 1, inputTokens: 4, outputTokens: 2, costUsd: expect.any(Number) },
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a.ts" } },
      { type: "tool_result", callId: "c1", isError: false, preview: "contents" },
      { type: "text_delta", round: 2, text: "done" },
      { type: "usage", round: 2, inputTokens: 6, outputTokens: 1, costUsd: expect.any(Number) },
    ]);
    expect(result.output).toBe("done");
  });

  test("the sink is invisible to nax: no sink, collecting, throwing and rejecting sinks give the same turn", async () => {
    const throwing: TurnEventSink = () => {
      throw new Error("sink exploded");
    };
    const rejecting: TurnEventSink = async () => {
      throw new Error("async sink exploded");
    };
    const baseline = await runTurn();
    for (const sink of [(_e: TurnEvent) => {}, throwing, rejecting]) {
      expect(await runTurn(sink)).toEqual(baseline);
    }
  });
});
```

If Biome flags the async `rejecting` declaration, add a targeted `// biome-ignore <rule>: the test needs an async sink that rejects` on that line. If the transcript or `TurnResult` carries a value that differs per run for a reason unrelated to the sink (a temp-dir path, a timestamp), strip that one field in `runTurn` and name it in a comment; never loosen the whole comparison.

- [ ] **Step 2: Run it**

Run: `cd packages/nax-agent && bun test ./test/unit/native/session-adapter-turn-events.test.ts --timeout=60000`
Expected: PASS (all wiring landed in Tasks 3-5). If it fails, the failure points at a wiring gap; fix the source, not the expectation. Show the equivalence test can fail: temporarily make the emitter's `emit` throw outside its try/catch, see it FAIL, revert.

- [ ] **Step 3: Assert the sink in the packed-tarball smoke**

In `packages/nax-agent/test/node/fixtures/packed-smoke.mjs`, change the `sendTurn` call to collect events and assert them:

```js
const turnEvents = [];
const turn = await adapter.sendTurn(handle, "hi", {
  interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  onTurnEvent: (event) => turnEvents.push(event),
});
assert.equal(turn.output, "packed-ok", `unexpected turn output: ${turn.output}`);
assert.deepEqual(
  turnEvents.map((event) => event.type),
  ["text_delta", "usage"],
  `unexpected turn events: ${JSON.stringify(turnEvents)}`,
);
assert.equal(turnEvents[0].text, "packed-ok");

// An async sink that rejects must not become an unhandled rejection (Node's
// default ends the process on one). Bun's unit test cannot show Node's behaviour.
const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
const again = await adapter.sendTurn(handle, "again", {
  interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  onTurnEvent: async () => {
    throw new Error("async sink exploded");
  },
});
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(again.output, "packed-ok");
assert.deepEqual(unhandled, [], `unhandled rejections: ${unhandled.map(String).join("; ")}`);
```

(The fixture's `stream` is a generator function, so each call replays the same three events.)

- [ ] **Step 4: Run every gate**

Run: `cd packages/nax-agent && bun run test && bun run typecheck && bun run check:all && bun run check:api && bun run test:coverage && bun run test:node`
Run: `cd packages/nax && bun run test && bun run typecheck && bun run check:all`
Run (repo root): `bun run typecheck && bun run check:all`
Expected: all PASS. Coverage: `stream-complete.ts` and `turn-event-emitter.ts` at or above 80% lines and functions; `check:api` clean (the Task 1 snapshot).
Confirm nax's CLI is untouched: from `packages/nax`, `bun bin/nax.ts --help | md5` and `bun bin/nax.ts --version` equal the same commands on `main` (stash or use a `main` worktree for the comparison).

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/test
git commit -m "test(nax-agent): onTurnEvent end to end through sendTurn and in the packed smoke"
```

---

### Task 7: Billed S1-recipe acceptance smoke, then the PR (controller only)

This task is NOT for an implementer subagent. The controller runs it, and the smoke needs the user's explicit approval at launch (spec §10.3; billed).

- [ ] **Step 1: Pre-push review.** Run a whole-branch code review (read-only reviewer) against this plan and the spec. Fix findings in at most two rounds.
- [ ] **Step 2: Ask for approval to launch the billed smoke**, stating the expected cost (the S1 run was $0.34, the S2 run $0.54).
- [ ] **Step 3: Run the smoke** on the S1 recipe: the clamp-helper PRD (status reset, no `nax plan`) on a fresh clone of this branch's head, a UNIQUE project name (for example `nax-s3-3-smoke`), the local build (`bun "$NAX" run -f <feature>`), after `nax trust add <dir> --yes`. Verify `run.start`'s `naxCommit` is the branch head.
- [ ] **Step 4: Compare against the S2 acceptance run.** Same story outcome (1/1 passed, acceptance verdict passed, deferred regression gate passed); tool-audit ledgers shape-identical (top-level keys, per-tool record keys, `reason` on every `error` record and on no `ok` record); cost rows with the same key set and `schemaVersion`. Explain every tool error.
- [ ] **Step 5: Open the PR** with the template sections (What / Why / How / Testing / Notes), the deviations above, the five Review Focus items and the smoke evidence. Update the master plan's S3 row.
