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
