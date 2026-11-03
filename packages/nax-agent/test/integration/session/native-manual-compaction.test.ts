/**
 * US-002: `session.compact()` on the native backend (spec "Manual compaction
 * (native)").
 *
 * Automatic compaction fires near the context limit. Manual compaction is the
 * person saying the finished exploration is over: the stored history is
 * reloaded, planned against the keep budget, summarized once, saved, and the
 * usage anchor cleared so the next turn re-estimates from the compacted array.
 * It ignores `compaction.enabled` (that flag governs automatic compaction only)
 * and dispatches no `before_compaction` event.
 *
 * Everything is observed through the scripted provider: a summary EXISTS when
 * `completeRequests` recorded a call, and a stored history is what the NEXT
 * `send()` puts on the wire.
 *
 * Windows are small on purpose (4095 tokens, the catalog minimum): with the
 * defaults that makes the keep budget 1228 estimated tokens and the compaction
 * threshold 3072, so a seeded transcript can sit above one and below (or above)
 * the other readably. Sizes are given in estimated tokens at 4 chars each.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type CompactResult,
  createAgentSession,
  resumeAgentSession,
  type SessionEvent,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import type { ClientRequest } from "@nathapp/nax-ai";
import { COMPACTION_SUMMARY_PREFIX } from "#src/native/session/compaction";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  collect,
  eventsOf,
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  type ScriptedProvider,
  SUMMARY_USAGE,
  sessionOptions,
  textRound,
} from "#test/helpers/agent-session";

afterEach(resetScriptedProvider);

const SAVED_AT = "2026-10-10T00:00:00.000Z";
/** Smallest catalog window: keep budget 1228 tokens, compaction threshold 3072. */
const WINDOW = 4095;
/** The keep budget that window and the default 30% produce. */
const KEEP = 1228;

const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

function text(tokens: number, fill = "x"): string {
  return fill.repeat(tokens * 4);
}

/**
 * A stored history above the keep budget AND above the threshold: 7001 tokens.
 *
 * The 1500-token tail is what makes the cut land past the first message — the
 * walk backwards reaches the keep budget at index 2, so the dropped span is
 * `[a1]` and the rest survives.
 */
function oversizedDoc(): TranscriptDoc {
  return {
    model: MODEL,
    savedAt: SAVED_AT,
    messages: [
      { role: "user", content: text(5000) },
      { role: "assistant", content: text(500, "a") },
      { role: "user", content: text(1500, "u") },
      { role: "assistant", content: "done" },
    ],
  };
}

/**
 * A stored history above the keep budget but BELOW the compaction threshold
 * (2100 tokens), so a turn taken before `compact()` does not compact
 * proactively. That is what makes AC-16's "no proactive compaction afterwards"
 * a statement about the anchor: the compacted tail is small enough that only a
 * stale anchor could cross the threshold.
 */
function smallButCompactableDoc(): TranscriptDoc {
  return {
    model: MODEL,
    savedAt: SAVED_AT,
    messages: [
      { role: "user", content: text(400) },
      { role: "assistant", content: text(400, "a") },
      { role: "user", content: text(300, "u") },
      { role: "assistant", content: text(1000, "b") },
    ],
  };
}

async function seeded(id: string, doc: TranscriptDoc): Promise<TranscriptStore> {
  const store = createMemoryTranscriptStore();
  await store.save(id, doc);
  return store;
}

/** Resumes a seeded session; the same store then carries whatever the test writes. */
async function openSession(
  id: string,
  store: TranscriptStore,
  extra: Parameters<typeof sessionOptions>[0] = {},
): Promise<AgentSession> {
  const session = await resumeAgentSession(
    id,
    sessionOptions({
      transcriptStore: store,
      compaction: { compactAtPercent: 90, keepRecentPercent: 30 },
      ...extra,
    }),
  );
  sessions.push(session);
  return session;
}

/** The facade always supplies `compact`; the contract keeps it optional for other backends. */
function compactNow(session: AgentSession): () => Promise<CompactResult> {
  const compact = session.compact;
  if (compact === undefined) throw new Error("the facade must always provide compact()");
  return compact.bind(session);
}

/** The messages the provider was sent for request `index` (negative counts from the end). */
function requestMessages(provider: ScriptedProvider, index: number): ClientRequest["messages"] {
  const request = provider.requests.at(index);
  if (request === undefined) throw new Error(`no request at index ${index}`);
  return request.messages;
}

/** The contents of the compaction-summary messages in a request. */
function summaryMessages(messages: ClientRequest["messages"]): string[] {
  return messages
    .filter((message) => message.role === "user" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX))
    .map((message) => message.content);
}

function compactionReasons(events: readonly SessionEvent[]): string[] {
  return eventsOf(events, "compaction").map((event) => event.reason);
}

describe("native manual compaction: above the keep budget", () => {
  test("AC-1: compact() resolves compacted: true with tokensAfter below tokensBefore", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete("a summary of what was tried");
    const store = await seeded("m-1", oversizedDoc());
    const session = await openSession("m-1", store);

    const result = await compactNow(session)();

    expect(result.compacted).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(KEEP);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(provider.completeRequests).toHaveLength(1);
  });

  test("AC-2: the next send() request begins with the summary message", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete("the exploration ended at b.ts");
    provider.push(textRound("carrying on"));
    const store = await seeded("m-2", oversizedDoc());
    const session = await openSession("m-2", store);
    await compactNow(session)();

    await collect(session.send("next"));

    const messages = requestMessages(provider, 0);
    expect(messages[0]).toEqual({
      role: "user",
      content: `${COMPACTION_SUMMARY_PREFIX}the exploration ended at b.ts\n</summary>\n`,
    });
    // Nothing before it: the manual path has no pinned task prompt, so the
    // summary really is the request's first message.
    expect(messages[1]).toEqual({ role: "user", content: text(1500, "u") });
    expect(messages).toHaveLength(4);
  });

  test("AC-3: compact() returns the summarizer's usage unchanged", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete("summary");
    const store = await seeded("m-3", oversizedDoc());
    const session = await openSession("m-3", store);

    const result = await compactNow(session)();

    expect(result.usage).toEqual(SUMMARY_USAGE);
  });

  test("AC-4: compact() returns the summarizer's costUsd unchanged", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete("summary");
    const store = await seeded("m-4", oversizedDoc());
    const session = await openSession("m-4", store);

    const result = await compactNow(session)();

    // The scripted catalog card is $3 in / $15 out per 1M and the summary reports
    // 7 in / 3 out: 7*3e-6 + 3*15e-6 = 66e-6. The assertion is the arithmetic,
    // not "nonzero": a turn's cost in place of the summary's is also nonzero.
    expect(result.costUsd).toBeCloseTo(66e-6, 12);
  });

  test("AC-7: compaction.enabled: false still compacts, because it governs automatic compaction only", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete("summary anyway");
    const store = await seeded("m-7", oversizedDoc());
    const session = await openSession("m-7", store, {
      compaction: { enabled: false, compactAtPercent: 90, keepRecentPercent: 30 },
    });

    const result = await compactNow(session)();

    expect(result.compacted).toBe(true);
    expect(provider.completeRequests).toHaveLength(1);
  });
});

describe("native manual compaction: nothing to drop", () => {
  /** Two tiny messages: far inside the keep budget. */
  function fittingDoc(): TranscriptDoc {
    return {
      model: MODEL,
      savedAt: SAVED_AT,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
  }

  test("AC-5: compact() resolves compacted: false with tokensAfter equal to tokensBefore", async () => {
    installScriptedProvider({ contextWindow: WINDOW });
    const store = await seeded("m-5", fittingDoc());
    const session = await openSession("m-5", store);

    const result = await compactNow(session)();

    expect(result.compacted).toBe(false);
    expect(result.tokensAfter).toBe(result.tokensBefore);
    expect(result.costUsd).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test("AC-6: compact() makes no summarizer call when the history fits", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    const store = await seeded("m-6", fittingDoc());
    const session = await openSession("m-6", store);

    await compactNow(session)();

    expect(provider.completeRequests).toEqual([]);
    // And nothing was rewritten: the next request still carries the history.
    provider.push(textRound("still here"));
    await collect(session.send("next"));
    expect(summaryMessages(requestMessages(provider, 0))).toEqual([]);
    expect(requestMessages(provider, 0).map((message) => message.content)).toContain("hello");
  });
});

describe("native manual compaction: a failing summarizer", () => {
  test("AC-13: compact() rejects with the summarizer's own error", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    const failure = new Error("summarizer offline");
    provider.pushComplete(failure);
    const store = await seeded("m-13", oversizedDoc());
    const session = await openSession("m-13", store);

    const caught = await compactNow(session)().then(
      () => undefined,
      (err: unknown) => err,
    );

    // The same object, not a re-wrapped one: the caller decides what to do.
    expect(caught).toBe(failure);
  });

  test("AC-14: after a failed compact() the next send() carries the uncompacted history", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete(new Error("summarizer offline"));
    provider.push(textRound("uncompacted"));
    const store = await seeded("m-14", oversizedDoc());
    const session = await openSession("m-14", store);
    await compactNow(session)().catch(() => undefined);

    const events = await collect(session.send("next"));

    const messages = requestMessages(provider, 0);
    // The whole seeded span is still on the wire and no summary replaced it.
    expect(messages[0]).toEqual({ role: "user", content: text(5000) });
    expect(messages[1]).toEqual({ role: "assistant", content: text(500, "a") });
    expect(summaryMessages(messages)).toEqual([]);
    expect(compactionReasons(events)).toEqual([]);
  });
});

describe("native manual compaction: the loop-event seam and the anchor", () => {
  test("AC-15: compact() dispatches no before_compaction, while a proactive turn still does", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete("manual summary", "proactive summary");
    provider.push(textRound("turn answer"));
    const reasons: string[] = [];
    const loopHandlers = [
      {
        plugin: "test",
        event: "before_compaction" as const,
        handler: (payload: unknown) => {
          // The entry is registered for before_compaction, so the narrower
          // reason is what a real dispatch carries; anything else would be a
          // handler wiring bug and is ignored rather than guessed at.
          const reason =
            typeof payload === "object" && payload !== null && "reason" in payload
              ? (payload as { readonly reason?: unknown }).reason
              : undefined;
          if (typeof reason === "string") reasons.push(reason);
          return {};
        },
      },
    ];
    const store = await seeded("m-15", oversizedDoc());
    const session = await openSession("m-15", store, { loopHandlers });
    await compactNow(session)();

    expect(reasons).toEqual([]);

    // The handler is installed and answerable — the negative above means
    // something only because a proactive compaction does reach it.
    const proactive = await seeded("m-15b", oversizedDoc());
    const other = await openSession("m-15b", proactive, { loopHandlers });
    await collect(other.send("next"));

    expect(reasons).toEqual(["proactive"]);
  });

  test("AC-16: a send() after compact() triggers no proactive compaction from a stale anchor", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    // The turn reports a 5000-token prompt: an anchor that still describes the
    // pre-compaction array, and that would cross the 3072-token threshold if it
    // survived. The next turn's 1000-token prompt is what would give a stale
    // compaction a real span to drop — so "one summarizer call" is the anchor
    // clearing, not the absence of anything to compact.
    provider.push(textRound("first answer", 5000));
    provider.push(textRound("after the compaction"), textRound("and again"));
    provider.pushComplete("manual summary");
    const store = await seeded("m-16", smallButCompactableDoc());
    const session = await openSession("m-16", store);
    await collect(session.send("one"));
    expect(provider.completeRequests).toEqual([]);

    const result = await compactNow(session)();
    const after = await collect(session.send(text(1000, "n")));

    expect(result.compacted).toBe(true);
    expect(provider.completeRequests).toHaveLength(1);
    expect(compactionReasons(after)).toEqual([]);
  });
});

describe("native manual compaction: the automatic path is unchanged", () => {
  test("AC-17: a proactive compaction's summarizer call receives the dropped span and previous summary", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    // Turn 1 compacts proactively (7001 tokens against a 3072 threshold) and
    // reports a 5000-token prompt, so turn 2's anchor crosses the threshold again.
    provider.push(textRound(text(2000, "d"), 5000), textRound("second"));
    provider.pushComplete("first summary", "merged summary");
    const store = await seeded("m-17", oversizedDoc());
    const session = await openSession("m-17", store);

    await collect(session.send("one"));
    await collect(session.send("two"));

    expect(provider.completeRequests).toHaveLength(2);
    const first = provider.completeRequests[0]?.messages ?? [];
    // The first compaction drops `[a1]`; there is no earlier summary to merge.
    expect(first[0]).toEqual({ role: "assistant", content: text(500, "a") });
    expect(first[1]?.content).not.toContain("Merge it into your summary");

    // The second receives the span it is dropping — the first turn's kept
    // history and prompt — plus the previous summary, offered for merging.
    const second = provider.completeRequests[1]?.messages ?? [];
    expect(second.slice(0, 3)).toEqual([
      { role: "user", content: text(1500, "u") },
      { role: "assistant", content: "done" },
      { role: "user", content: "one" },
    ]);
    expect(second[3]).toMatchObject({
      role: "user",
      // One matcher: Bun's toMatchObject mutates the received value in place, so
      // two matchers on the same message do not both see the original string.
      content: expect.stringMatching(/Merge it into your summary[\s\S]*first summary/),
    });
    expect(second).toHaveLength(4);
  });

  test("the next automatic compaction merges a manual summary instead of stacking it", async () => {
    // The manual path writes the summary at index 0 (no pin). An automatic
    // compaction of that transcript has to find it there, or the only record of
    // the shed work is silently lost — and must replace it, not follow it, or
    // the older summary becomes unremovable.
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    provider.pushComplete("manual summary");
    provider.push(textRound(text(2000, "d"), 5000), textRound("second"));
    provider.pushComplete("merged summary");
    const store = await seeded("m-18", oversizedDoc());
    const session = await openSession("m-18", store);

    await compactNow(session)();
    // Turn one reports the big prompt (no compaction: the array is small now),
    // turn two's anchor crosses the threshold and compacts automatically.
    await collect(session.send("first"));
    const events = await collect(session.send("second"));

    expect(compactionReasons(events)).toEqual(["proactive"]);
    expect(provider.completeRequests).toHaveLength(2);
    expect(provider.completeRequests[1]?.messages.at(-1)).toMatchObject({
      content: expect.stringContaining("manual summary"),
    });
    const sent = summaryMessages(requestMessages(provider, 1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("merged summary");
  });
});

describe("native manual compaction: a fresh session", () => {
  test("compact() on a session with no history is a no-op", async () => {
    const provider = installScriptedProvider({ contextWindow: WINDOW });
    const session = await createAgentSession(sessionOptions({ compaction: { keepRecentPercent: 30 } }));
    sessions.push(session);

    const result = await compactNow(session)();

    expect(result).toEqual({
      compacted: false,
      tokensBefore: 0,
      tokensAfter: 0,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(provider.completeRequests).toEqual([]);
  });
});
