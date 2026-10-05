/**
 * S3-4: createAgentSession end to end against a scripted streaming provider
 * (spec 4.1, 4.2, 4.4, 5.5). Multi-turn chat with history, the event shape,
 * the system prompt, the advertised tools per profile, the markTurn write
 * order, single-flight, close, and turn failures as turn_end.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, type EmbedderTool, type SessionEvent, type TranscriptStore } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";
import { _clientDeps } from "#src/native/client";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { turnEndFromResult } from "#src/session/agent-session-turn";
import type { TurnResult } from "#src/session/session-types";
import {
  collect,
  eventsOf,
  faultRound,
  installScriptedProvider,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  turnEndOf,
  types,
} from "#test/helpers/agent-session";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

afterEach(resetScriptedProvider);

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
}

const lookup: EmbedderTool = {
  name: "lookup",
  description: "look a record up",
  inputSchema: { type: "object" },
  approval: "never",
  async run() {
    return { content: "record" };
  },
};

function spyStore(): { store: TranscriptStore; calls: string[] } {
  const inner = createMemoryTranscriptStore();
  const calls: string[] = [];
  const store: TranscriptStore = {
    load: (id) => {
      calls.push("load");
      return inner.load(id);
    },
    save: (id, doc) => {
      calls.push("save");
      return inner.save(id, doc);
    },
    retainFailed: (id) => {
      calls.push("retainFailed");
      return inner.retainFailed(id);
    },
    delete: (id) => {
      calls.push("delete");
      return inner.delete(id);
    },
    markTurn: (id, marker) => {
      calls.push(`markTurn:${marker.state}`);
      return inner.markTurn(id, marker);
    },
  };
  return { store, calls };
}

describe("createAgentSession: chat", () => {
  test("two turns stream deltas and usage, end with turn_end, and carry history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("Hello"), textRound("Again"));
    const session = await createAgentSession(sessionOptions({ sessionId: "chat-1", metadata: { tenant: "t1" } }));
    const first = await collect(session.send("hi"));
    expect(types(first)).toEqual(["turn_start", "text_delta", "usage", "turn_end"]);
    const end = turnEndOf(first);
    expect(end).toMatchObject({ status: "completed", output: "Hello", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(end.error).toBeUndefined();
    for (const event of first) {
      expect(event.sessionId).toBe("chat-1");
      expect(event.turnId).toBe(end.turnId);
      expect(event.metadata).toEqual({ tenant: "t1" });
      expect(Number.isNaN(Date.parse(event.at))).toBe(false);
    }
    expect(session.lastTurn).toEqual({ turnId: end.turnId, status: "completed" });

    const second = await collect(session.send("again"));
    expect(turnEndOf(second).output).toBe("Again");
    expect(turnEndOf(second).turnId).not.toBe(end.turnId);
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      expect.objectContaining({ role: "assistant", content: "Hello" }),
      { role: "user", content: "again" },
    ]);
    await session.close();
  });

  test("a session with its own credentials builds a client of its own with them", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const scripted = _clientDeps.build;
    const seen: unknown[] = [];
    _clientDeps.build = async (overrides, options) => {
      seen.push(options);
      return scripted(overrides, options);
    };
    const session = await createAgentSession(
      sessionOptions({ credentials: { kind: "memory", credentials: { openai: { kind: "api-key", key: "k" } } } }),
    );
    await collect(session.send("hi"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ credentials: expect.anything() });
    await session.close();
  });

  test("instructions reach the provider as the system field", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const session = await createAgentSession(sessionOptions({ instructions: "Answer in one word." }));
    await collect(session.send("hi"));
    expect(provider.requests[0]?.system).toBe("Answer in one word.");
    await session.close();
  });

  test("the none profile advertises the scratchpad trio, embedder tools and ask_human; read adds the read tools", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("a"), textRound("b"));
    const none = await createAgentSession(sessionOptions({ tools: [lookup] }));
    await collect(none.send("hi"));
    expect(provider.requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(
      ["ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human", "lookup"].sort(),
    );
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-session-read-"));
    const read = await createAgentSession(sessionOptions({ profile: "read", workdir }));
    await collect(read.send("hi"));
    expect(provider.requests[1]?.tools?.map((tool) => tool.name).sort()).toEqual(
      ["Git", "Glob", "Grep", "Read", "ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human"].sort(),
    );
    await none.close();
    await read.close();
  });

  test("write order per turn is markTurn(running), the loop's save, markTurn(ended); close keeps the document", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const { store, calls } = spyStore();
    const session = await createAgentSession(sessionOptions({ transcriptStore: store }));
    const events = await collect(session.send("hi"));
    expect(calls.filter((call) => call !== "load" && call !== "delete")).toEqual([
      "markTurn:running",
      "save",
      "markTurn:ended",
    ]);
    const before = calls.length;
    await session.close();
    expect(calls.slice(before)).toEqual([]);
    const doc = await store.load(session.id);
    expect(doc?.turn).toEqual({ turnId: turnEndOf(events).turnId, state: "ended" });
    expect(doc?.messages).toHaveLength(2);
  });

  test("a sessionId that already has a document is refused, and the document is untouched", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("taken", { savedAt: "2026-10-04T00:00:00.000Z", messages: [{ role: "user", content: "old" }] });
    await rejectsWith(
      createAgentSession(sessionOptions({ sessionId: "taken", transcriptStore: store })),
      "AGENT_SESSION_EXISTS",
    );
    expect((await store.load("taken"))?.messages).toEqual([{ role: "user", content: "old" }]);
  });

  test("a workdir that is not a directory is an invalid option", async () => {
    await rejectsWith(
      createAgentSession(sessionOptions({ profile: "read", workdir: "/nonexistent/nax-agent-session" })),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });
});

describe("createAgentSession: single flight and close", () => {
  withDepsRestore(_agentSessionDeps);

  test("a claimed turn makes send busy; the iterable is single-use; cancel releases an unstarted claim", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const session = await createAgentSession(sessionOptions());
    const claimed = session.send("never iterated");
    expectCode(() => session.send("second"), "AGENT_SESSION_BUSY");
    session.cancel();
    expect(await collect(claimed)).toEqual([]);
    expectCode(() => claimed[Symbol.asyncIterator](), "AGENT_SESSION_BUSY");
    const events = await collect(session.send("third"));
    expect(turnEndOf(events).status).toBe("completed");
    await session.close();
  });

  test("send() from inside the loop on turn_end succeeds: the slot is free before turn_end arrives", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"), textRound("two"));
    const session = await createAgentSession(sessionOptions());
    let second: SessionEvent[] = [];
    for await (const event of session.send("first")) {
      if (event.type === "turn_end") second = await collect(session.send("second"));
    }
    expect(turnEndOf(second).output).toBe("two");
    await session.close();
  });

  test("close is idempotent, removes the private root, and later sends and answers are refused", async () => {
    installScriptedProvider();
    const removed: string[] = [];
    const realRemove = _agentSessionDeps.removeScratchRoot;
    _agentSessionDeps.removeScratchRoot = async (dir) => {
      removed.push(dir);
      await realRemove(dir);
    };
    const session = await createAgentSession(sessionOptions());
    const a = session.close();
    const b = session.close();
    expect(a).toBe(b);
    await a;
    expect(removed).toHaveLength(1);
    expect(existsSync(removed[0] ?? "")).toBe(false);
    expectCode(() => session.send("hi"), "AGENT_SESSION_CLOSED");
    expect(session.answer("anything", { decision: "allow" })).toBe("unknown");
  });
});

describe("turnEndFromResult", () => {
  const result = (extra: Partial<TurnResult> = {}): TurnResult => ({
    output: "partial",
    tokenUsage: { inputTokens: 3, outputTokens: 1 },
    estimatedCostUsd: 0.5,
    internalRoundTrips: 1,
    ...extra,
  });

  test("a clean result completes and prefers the exact cost", () => {
    expect(turnEndFromResult(result({ exactCostUsd: 0.4 }))).toMatchObject({
      status: "completed",
      output: "partial",
      costUsd: 0.4,
    });
  });

  test("timedOut wins over the incomplete flag it implies", () => {
    expect(turnEndFromResult(result({ timedOut: true, turnIncomplete: true })).status).toBe("timed_out");
  });

  test.each([
    [{ spinStopped: true, turnIncomplete: true }, "AGENT_SESSION_SPIN_STOPPED"],
    [{ invalidCallBudgetExceeded: true, turnIncomplete: true }, "AGENT_SESSION_INVALID_TOOL_CALLS"],
    [{ turnIncomplete: true }, "AGENT_SESSION_TURN_INCOMPLETE"],
  ] satisfies Array<[Partial<TurnResult>, string]>)(
    "a loop halt %p ends errored with %p, keeping output and usage",
    (flags, code) => {
      const end = turnEndFromResult(result(flags));
      expect(end).toMatchObject({ status: "errored", output: "partial", usage: { inputTokens: 3, outputTokens: 1 } });
      expect(end.error?.code).toBe(code);
    },
  );
});

describe("createAgentSession: turn failures arrive as turn_end", () => {
  test("a provider auth fault ends the turn errored with the adapter outcome", async () => {
    const provider = installScriptedProvider();
    provider.push([{ type: "error", error: { kind: "auth", message: "bad key" } }]);
    const session = await createAgentSession(sessionOptions());
    const end = turnEndOf(await collect(session.send("hi")));
    expect(end.status).toBe("errored");
    expect(end.error?.code).toBe("fail-auth");
    expect(session.lastTurn?.status).toBe("errored");
    await session.close();
  });

  test("a store that throws a NaxError ends the turn with that error's code", async () => {
    const provider = installScriptedProvider();
    const inner = createMemoryTranscriptStore();
    const store: TranscriptStore = {
      load: (id) => inner.load(id),
      save: (id, doc) => inner.save(id, doc),
      retainFailed: (id) => inner.retainFailed(id),
      delete: (id) => inner.delete(id),
      markTurn: async () => {
        throw new NaxError("store offline", "STORE_OFFLINE", { stage: "test" });
      },
    };
    const session = await createAgentSession(sessionOptions({ transcriptStore: store }));
    expect(turnEndOf(await collect(session.send("hi"))).error?.code).toBe("STORE_OFFLINE");
    expect(provider.requests).toHaveLength(0);
    await session.close();
  });

  test("a store whose markTurn throws fails the turn before any model call", async () => {
    const provider = installScriptedProvider();
    const inner = createMemoryTranscriptStore();
    const store: TranscriptStore = {
      load: (id) => inner.load(id),
      save: (id, doc) => inner.save(id, doc),
      retainFailed: (id) => inner.retainFailed(id),
      delete: (id) => inner.delete(id),
      markTurn: async () => {
        throw new Error("disk full");
      },
    };
    const session = await createAgentSession(sessionOptions({ transcriptStore: store }));
    const end = turnEndOf(await collect(session.send("hi")));
    expect(end).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_TURN_FAILED", message: "disk full" },
    });
    expect(provider.requests).toHaveLength(0);
    await session.close();
  });
});

describe("createAgentSession: transport retry", () => {
  test("a transport fault after streamed text is retried: stream_reset voids the deltas and the turn completes", async () => {
    const provider = installScriptedProvider();
    provider.push(faultRound("stale"), textRound("fresh"));
    const session = await createAgentSession(sessionOptions());
    const events = await collect(session.send("hi"));
    expect(types(events)).toEqual(["turn_start", "text_delta", "stream_reset", "text_delta", "usage", "turn_end"]);
    expect(eventsOf(events, "stream_reset")[0]).toMatchObject({ round: 1, attempt: 2 });
    expect(turnEndOf(events)).toMatchObject({ status: "completed", output: "fresh" });
    expect(provider.requests).toHaveLength(2);
    await session.close();
  });

  test("a fault on every attempt ends the turn errored after three attempts", async () => {
    const provider = installScriptedProvider();
    provider.push(faultRound("a"), faultRound("b"), faultRound("c"));
    const session = await createAgentSession(sessionOptions());
    const end = turnEndOf(await collect(session.send("hi")));
    expect(end.status).toBe("errored");
    expect(provider.requests).toHaveLength(3);
    await session.close();
  });
});
