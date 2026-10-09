/**
 * The facade's native backend compacts a conversational session the way
 * `nax run` does: proactively when the history crosses compactAtPercent of the
 * window, and reactively on a context overflow. On by default; `enabled: false`
 * restores the old behaviour. Driven end to end against a scripted provider.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAgentSession,
  resumeAgentSession,
  type SessionEvent,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { COMPACTION_SUMMARY_PREFIX } from "#src/native/session/compaction";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  collect,
  eventsOf,
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  turnEndOf,
  types,
} from "#test/helpers/agent-session";

afterEach(resetScriptedProvider);

const SAVED_AT = "2026-10-10T00:00:00.000Z";

/** Roughly 10k estimated tokens: past 90% of an 8000-token window, inside a 20000-token one. */
function bigDoc(chars: number): TranscriptDoc {
  return {
    model: MODEL,
    savedAt: SAVED_AT,
    messages: [
      { role: "user", content: "the task" },
      { role: "assistant", content: "a".repeat(chars) },
      { role: "user", content: "keep going" },
      { role: "assistant", content: "b".repeat(chars) },
    ],
  };
}

async function seeded(id: string, doc: TranscriptDoc): Promise<TranscriptStore> {
  const store = createMemoryTranscriptStore();
  await store.save(id, doc);
  return store;
}

function compactions(events: readonly SessionEvent[]): string[] {
  return eventsOf(events, "compaction").map((event) => event.reason);
}

const overflowRound = [{ type: "error", error: { kind: "context-overflow", message: "prompt is too long" } }] as const;

describe("native backend compaction: proactive", () => {
  test("a history past the threshold is compacted before the call and the turn answers", async () => {
    const provider = installScriptedProvider({ contextWindow: 8000 });
    provider.push(textRound("answer"));
    provider.pushComplete("earlier work, summarized");
    const store = await seeded("c-1", bigDoc(20_000));

    const session = await resumeAgentSession("c-1", sessionOptions({ transcriptStore: store }));
    const events = await collect(session.send("next"));

    expect(compactions(events)).toEqual(["proactive"]);
    expect(turnEndOf(events).status).toBe("completed");
    expect(turnEndOf(events).output).toBe("answer");
    expect(provider.completeRequests).toHaveLength(1);
    const sent = provider.requests[0]?.messages ?? [];
    expect(sent[0]).toEqual({ role: "user", content: "the task" });
    expect(sent[1]).toEqual({
      role: "user",
      content: expect.stringContaining(`${COMPACTION_SUMMARY_PREFIX}earlier work, summarized`),
    });
    await session.close();
  });

  test("the summary call emits no usage event and compaction precedes the round's usage", async () => {
    const provider = installScriptedProvider({ contextWindow: 8000 });
    provider.push(textRound("answer"));
    provider.pushComplete("summary");
    const store = await seeded("c-2", bigDoc(20_000));

    const session = await resumeAgentSession("c-2", sessionOptions({ transcriptStore: store }));
    const events = await collect(session.send("next"));

    expect(eventsOf(events, "usage")).toHaveLength(1);
    const order = types(events);
    expect(order.indexOf("compaction")).toBeLessThan(order.indexOf("usage"));
    await session.close();
  });

  test("the stored transcript after the turn is the compacted history, and a restart resumes from it", async () => {
    const provider = installScriptedProvider({ contextWindow: 8000 });
    provider.push(textRound("answer"), textRound("second answer"));
    provider.pushComplete("summary of the middle");
    const store = await seeded("c-3", bigDoc(20_000));

    const session = await resumeAgentSession("c-3", sessionOptions({ transcriptStore: store }));
    await collect(session.send("next"));
    await session.close();

    const doc = await store.load("c-3");
    const contents = (doc?.messages ?? []).map((m) => m.content);
    expect(contents[0]).toBe("the task");
    expect(contents[1]).toContain("summary of the middle");
    expect(contents.join("")).not.toContain("a".repeat(20_000));
    expect(contents.at(-2)).toBe("next");
    expect(contents.at(-1)).toBe("answer");

    const resumed = await resumeAgentSession("c-3", sessionOptions({ transcriptStore: store }));
    const events = await collect(resumed.send("again"));
    expect(compactions(events)).toEqual([]);
    expect(provider.completeRequests).toHaveLength(1);
    const sent = provider.requests[1]?.messages ?? [];
    expect(sent[1]).toEqual({
      role: "user",
      content: expect.stringContaining("summary of the middle"),
    });
    expect(sent.at(-1)).toEqual({ role: "user", content: "again" });
    await resumed.close();
  });

  test("a fresh createAgentSession compacts once its own history grows past the threshold", async () => {
    const provider = installScriptedProvider({ contextWindow: 8000 });
    provider.push(textRound("c".repeat(8000), 3000), textRound("d".repeat(8000), 6500), textRound("last"));
    provider.pushComplete("rolled up");
    const session = await createAgentSession(
      sessionOptions({ sessionId: "c-4", compaction: { keepRecentPercent: 20 } }),
    );

    const first = await collect(session.send("one"));
    const second = await collect(session.send("two"));
    const third = await collect(session.send("three"));

    expect(compactions(first)).toEqual([]);
    expect(compactions(second)).toEqual([]);
    expect(compactions(third)).toEqual(["proactive"]);
    expect(turnEndOf(third).status).toBe("completed");
    await session.close();
  });
});

describe("native backend compaction: overflow", () => {
  test("a context overflow compacts, retries and answers", async () => {
    const provider = installScriptedProvider({ contextWindow: 20_000 });
    provider.push(overflowRound, textRound("recovered"));
    provider.pushComplete("overflow summary");
    const store = await seeded("o-1", bigDoc(16_000));

    const session = await resumeAgentSession("o-1", sessionOptions({ transcriptStore: store }));
    const events = await collect(session.send("next"));

    expect(compactions(events)).toEqual(["overflow"]);
    expect(turnEndOf(events).output).toBe("recovered");
    expect(provider.requests).toHaveLength(2);
    expect(provider.completeRequests).toHaveLength(1);
    await session.close();
  });
});

describe("native backend compaction: disabled", () => {
  test("enabled: false never compacts a history past the threshold", async () => {
    const provider = installScriptedProvider({ contextWindow: 8000 });
    provider.push(textRound("answer"));
    const store = await seeded("d-1", bigDoc(20_000));

    const session = await resumeAgentSession(
      "d-1",
      sessionOptions({ transcriptStore: store, compaction: { enabled: false } }),
    );
    const events = await collect(session.send("next"));

    expect(compactions(events)).toEqual([]);
    expect(provider.completeRequests).toHaveLength(0);
    expect(provider.requests[0]?.messages).toHaveLength(5);
    await session.close();
  });

  test("enabled: false leaves a context overflow to fail the turn", async () => {
    const provider = installScriptedProvider({ contextWindow: 20_000 });
    provider.push(overflowRound);
    const store = await seeded("d-2", bigDoc(16_000));

    const session = await resumeAgentSession(
      "d-2",
      sessionOptions({ transcriptStore: store, compaction: { enabled: false } }),
    );
    const events = await collect(session.send("next"));

    expect(compactions(events)).toEqual([]);
    expect(turnEndOf(events).status).toBe("errored");
    await session.close();
  });

  test("custom thresholds are honoured: a high compactAtPercent keeps the same history uncompacted", async () => {
    const provider = installScriptedProvider({ contextWindow: 8000 });
    provider.push(textRound("answer"));
    const store = await seeded("d-3", bigDoc(14_000));

    const session = await resumeAgentSession(
      "d-3",
      sessionOptions({ transcriptStore: store, compaction: { compactAtPercent: 99, keepRecentPercent: 20 } }),
    );
    const events = await collect(session.send("next"));

    expect(compactions(events)).toEqual([]);
    await session.close();
  });
});
