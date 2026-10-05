/**
 * S3-5: resumeAgentSession (spec 4.2, 5.5, 6.4). History carries over a
 * resume; a running marker left by a dead process is ended and reported as
 * interrupted; the stored document is checked before any backend opens; the
 * resumed id is the argument; a resume never deletes the document.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAgentSession, resumeAgentSession, type TranscriptDoc, type TranscriptStore } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { interruptedTurnOf } from "#src/session/agent-session-resume";
import {
  collect,
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

afterEach(resetScriptedProvider);

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

/** A store that records every call by name and delegates to `inner`. */
function spyStore(inner: TranscriptStore = createMemoryTranscriptStore()): { store: TranscriptStore; calls: string[] } {
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

/** A store whose load returns `raw` parsed: shapes TranscriptDoc's type cannot express. */
function rawStore(raw: string): TranscriptStore {
  const inner = createMemoryTranscriptStore();
  return { ...inner, load: async () => JSON.parse(raw) };
}

const SAVED_AT = "2026-10-05T00:00:00.000Z";

function priorDoc(model: string | undefined): TranscriptDoc {
  return {
    ...(model !== undefined ? { model } : {}),
    savedAt: SAVED_AT,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  };
}

describe("resumeAgentSession: history and restart", () => {
  test("a session resumed from its store carries its history into the next turn and never deletes it", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("one"), textRound("two"));
    const { store, calls } = spyStore();
    const first = await createAgentSession(sessionOptions({ sessionId: "r-1", transcriptStore: store }));
    await collect(first.send("first"));
    await first.close();
    calls.length = 0;

    const resumed = await resumeAgentSession("r-1", sessionOptions({ transcriptStore: store }));
    expect(resumed.id).toBe("r-1");
    expect(resumed.lastTurn).toBeUndefined();
    const events = await collect(resumed.send("second"));
    expect(turnEndOf(events).output).toBe("two");
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "first" },
      expect.objectContaining({ role: "assistant", content: "one" }),
      { role: "user", content: "second" },
    ]);
    expect(calls).not.toContain("delete");
    await resumed.close();
  });

  test("a running marker left by a dead process is ended and reported as interrupted", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("back"));
    const store = createMemoryTranscriptStore();
    await store.save("r-2", priorDoc(MODEL));
    await store.markTurn("r-2", { turnId: "t-dead", state: "running" });

    const session = await resumeAgentSession("r-2", sessionOptions({ transcriptStore: store }));
    expect(session.lastTurn).toEqual({ turnId: "t-dead", status: "interrupted" });
    expect((await store.load("r-2"))?.turn).toEqual({ turnId: "t-dead", state: "ended" });

    const end = turnEndOf(await collect(session.send("are you there")));
    expect(end.status).toBe("completed");
    expect(session.lastTurn).toEqual({ turnId: end.turnId, status: "completed" });
    expect(provider.requests[0]?.messages[0]).toEqual({ role: "user", content: "hi" });
    await session.close();
  });

  test("a marker-only document (a first turn that failed before the loop saved) resumes with empty history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("fresh"));
    const store = createMemoryTranscriptStore();
    await store.markTurn("r-3", { turnId: "t0", state: "ended" });

    const session = await resumeAgentSession("r-3", sessionOptions({ transcriptStore: store }));
    expect(session.lastTurn).toBeUndefined();
    await collect(session.send("hi"));
    expect(provider.requests[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
    await session.close();
  });

  test("an effort suffix is not a different model: the document resumes and its history carries", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("ok"));
    const store = createMemoryTranscriptStore();
    await store.save("r-4", priorDoc(MODEL));

    const session = await resumeAgentSession(
      "r-4",
      sessionOptions({ transcriptStore: store, model: `${MODEL}[high]` }),
    );
    await collect(session.send("next"));
    expect(provider.requests[0]?.messages).toHaveLength(3);
    await session.close();
  });
});

describe("resumeAgentSession: refusals", () => {
  test("a missing document is NOT_FOUND after a single load", async () => {
    const { store, calls } = spyStore();
    await rejectsWith(
      resumeAgentSession("absent", sessionOptions({ transcriptStore: store })),
      "AGENT_SESSION_NOT_FOUND",
    );
    expect(calls).toEqual(["load"]);
  });

  test("an unknown schemaVersion is SCHEMA_UNSUPPORTED", async () => {
    const store = rawStore('{"schemaVersion":2,"savedAt":"t","messages":[]}');
    await rejectsWith(
      resumeAgentSession("r-5", sessionOptions({ transcriptStore: store })),
      "AGENT_SESSION_SCHEMA_UNSUPPORTED",
    );
  });

  test("a document whose messages is not an array is TRANSCRIPT_CORRUPT", async () => {
    const store = rawStore('{"savedAt":"t","messages":{}}');
    await rejectsWith(resumeAgentSession("r-6", sessionOptions({ transcriptStore: store })), "TRANSCRIPT_CORRUPT");
  });

  test("a document written by another model is MODEL_MISMATCH; one with no recorded model resumes", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("r-7", priorDoc("openai/gpt-5.4"));
    await rejectsWith(
      resumeAgentSession("r-7", sessionOptions({ transcriptStore: store })),
      "AGENT_SESSION_MODEL_MISMATCH",
    );
    await store.save("r-8", priorDoc(undefined));
    const session = await resumeAgentSession("r-8", sessionOptions({ transcriptStore: store }));
    await session.close();
  });

  test("the resumed id is the argument: a path-shaped id or a different options.sessionId is refused before the store is read", async () => {
    const { store, calls } = spyStore();
    await rejectsWith(
      resumeAgentSession("../escape", sessionOptions({ transcriptStore: store })),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
    await rejectsWith(
      resumeAgentSession("a", sessionOptions({ transcriptStore: store, sessionId: "b" })),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
    expect(calls).toEqual([]);
    await store.save("a", priorDoc(MODEL));
    const session = await resumeAgentSession("a", sessionOptions({ transcriptStore: store, sessionId: "a" }));
    expect(session.id).toBe("a");
    await session.close();
  });
});

describe("resumeAgentSession: a store that fails while ending the interrupted turn", () => {
  withDepsRestore(_agentSessionDeps);

  test("fails the resume with the store's error, closes the session and removes its private root", async () => {
    const removed: string[] = [];
    const remove = _agentSessionDeps.removeScratchRoot;
    _agentSessionDeps.removeScratchRoot = async (dir) => {
      removed.push(dir);
      await remove(dir);
    };
    const inner = createMemoryTranscriptStore();
    await inner.save("r-9", priorDoc(MODEL));
    await inner.markTurn("r-9", { turnId: "t-dead", state: "running" });
    const store: TranscriptStore = {
      ...inner,
      markTurn: async () => {
        throw new NaxError("store is down", "STORE_DOWN", { stage: "test" });
      },
    };
    await rejectsWith(resumeAgentSession("r-9", sessionOptions({ transcriptStore: store })), "STORE_DOWN");
    expect(removed).toHaveLength(1);
  });
});

describe("interruptedTurnOf", () => {
  test("names the turn of a running marker only", () => {
    expect(interruptedTurnOf({ savedAt: SAVED_AT, messages: [], turn: { turnId: "t", state: "running" } })).toBe("t");
    expect(
      interruptedTurnOf({ savedAt: SAVED_AT, messages: [], turn: { turnId: "t", state: "ended" } }),
    ).toBeUndefined();
    expect(interruptedTurnOf({ savedAt: SAVED_AT, messages: [] })).toBeUndefined();
  });
});
