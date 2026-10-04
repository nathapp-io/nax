/**
 * S3-1 (S3 spec 5.5): native sessions load and save through an injected
 * TranscriptStore, open refuses an ambiguous transcript source, and
 * `retainOnClose` leaves the live document in place on close.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  type NativeSessionState,
  openNativeSession,
} from "#src/native/session/session";
import type { TranscriptDoc } from "#src/native/session/transcript-types";
import { runNativeTurn } from "#src/native/session/turn-loop";
import type { OpenSessionOpts, SendTurnOpts, SessionHandle } from "#src/session/session-types";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

let workdir: string;
let state: NativeSessionState;
beforeEach(() => {
  workdir = makeTempDir("nax-transcript-port-");
  state = createNativeSessionState();
});
afterEach(() => {
  cleanupTempDir(workdir);
});

const base = (extra: Partial<OpenSessionOpts>): OpenSessionOpts => ({
  agentName: "native",
  workdir,
  timeoutSeconds: 60,
  modelDef: { provider: "anthropic", model: "anthropic/claude-sonnet-5-5" },
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  resume: true,
  ...extra,
});
const opts: SendTurnOpts = { interactionHandler: { onInteraction: async () => ({ answer: "" }) } };
const reply = { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };

function turn(handle: SessionHandle, prompt: string): Promise<unknown> {
  return runNativeTurn(handle, prompt, opts, { sessionState: state, complete: async () => reply });
}

/** Runs one turn and returns every message array the provider was sent. */
async function sentOn(handle: SessionHandle, prompt: string): Promise<ConversationMessage[][]> {
  const sent: ConversationMessage[][] = [];
  await runNativeTurn(handle, prompt, opts, {
    sessionState: state,
    complete: async (messages) => {
      sent.push([...messages]);
      return reply;
    },
  });
  return sent;
}

const prior: ConversationMessage[] = [
  { role: "user", content: "old question" },
  { role: "assistant", content: "old answer" },
];

describe("native sessions on an injected TranscriptStore", () => {
  test("two turns share history through the store and nothing is written to disk", async () => {
    const store = createMemoryTranscriptStore();
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    await turn(handle, "one");
    await turn(handle, "two");
    const doc = await store.load("s");
    expect(doc?.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["one", "two"]);
    expect((await readdir(workdir)).filter((n) => n.includes(".transcript."))).toEqual([]);
  });

  test("a store whose load throws fails the turn", async () => {
    const store = { ...createMemoryTranscriptStore(), load: () => Promise.reject(new Error("load boom")) };
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    await expect(turn(handle, "one")).rejects.toThrow("load boom");
  });

  test("open refuses both transcriptDir and transcriptStore", async () => {
    await expect(
      openNativeSession(state, "s", base({ transcriptDir: workdir, transcriptStore: createMemoryTranscriptStore() })),
    ).rejects.toMatchObject({ code: "NATIVE_TRANSCRIPT_SOURCE_CONFLICT" });
    expect(state.transcripts.has("s")).toBe(false);
  });

  test("open with neither still throws NATIVE_TRANSCRIPT_DIR_MISSING", async () => {
    await expect(openNativeSession(state, "s", base({}))).rejects.toMatchObject({
      code: "NATIVE_TRANSCRIPT_DIR_MISSING",
    });
  });

  test("open without resume deletes the store's document", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: "t", messages: [{ role: "user", content: "old" }] });
    await openNativeSession(state, "s", base({ transcriptStore: store, resume: false }));
    expect(await store.load("s")).toBeNull();
  });

  test("retainOnClose keeps the live document after a clean close", async () => {
    const store = createMemoryTranscriptStore();
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store, retainOnClose: true }));
    await turn(handle, "one");
    await closeNativeSession(state, handle);
    expect(await store.load("s")).not.toBeNull();
    expect(state.transcripts.has("s")).toBe(false);
  });

  test("retainOnClose keeps the live document after a failed turn, unrenamed", async () => {
    const store = createMemoryTranscriptStore();
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store, retainOnClose: true }));
    await turn(handle, "one");
    markNativeTurnOutcome(state, "s", true);
    await closeNativeSession(state, handle);
    expect(await store.load("s")).not.toBeNull();
    expect(store.retained("s")).toBeUndefined();
  });

  test("without retainOnClose a failed close retains and a clean close deletes", async () => {
    const failedStore = createMemoryTranscriptStore();
    const h1 = await openNativeSession(state, "f", base({ transcriptStore: failedStore }));
    await turn(h1, "one");
    markNativeTurnOutcome(state, "f", true);
    await closeNativeSession(state, h1);
    expect(await failedStore.load("f")).toBeNull();
    expect(failedStore.retained("f")).not.toBeUndefined();

    const cleanStore = createMemoryTranscriptStore();
    const h2 = await openNativeSession(state, "c", base({ transcriptStore: cleanStore }));
    await turn(h2, "one");
    await closeNativeSession(state, h2);
    expect(await cleanStore.load("c")).toBeNull();
    expect(cleanStore.retained("c")).toBeUndefined();
  });

  test("a custom store cannot hand another owner's history to the loop", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { owner: "a", savedAt: "t", messages: prior });
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store, transcriptOwner: "b" }));
    const sent = await sentOn(handle, "new");
    expect(sent[0]).toEqual([{ role: "user", content: "new" }]);
  });

  test("a custom store cannot hand another model's history to the loop", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { model: "openai/other", savedAt: "t", messages: prior });
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    const sent = await sentOn(handle, "new");
    expect(sent[0]).toEqual([{ role: "user", content: "new" }]);
  });

  test("an unknown schemaVersion from a store fails the turn", async () => {
    const store = createMemoryTranscriptStore();
    const future: TranscriptDoc = JSON.parse('{"schemaVersion":2,"savedAt":"t","messages":[]}');
    await store.save("s", future);
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    await expect(turn(handle, "one")).rejects.toMatchObject({ code: "TRANSCRIPT_SCHEMA_UNSUPPORTED" });
  });

  test("a store document whose messages is not an array fails the turn with TRANSCRIPT_CORRUPT", async () => {
    const bad: TranscriptDoc = JSON.parse('{"savedAt":"t","messages":"abc"}');
    const store = { ...createMemoryTranscriptStore(), load: () => Promise.resolve(bad) };
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    await expect(turn(handle, "one")).rejects.toMatchObject({ code: "TRANSCRIPT_CORRUPT" });
  });

  test("a failing turn-end save fails the turn", async () => {
    const store = { ...createMemoryTranscriptStore(), save: () => Promise.reject(new Error("save boom")) };
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    await expect(turn(handle, "one")).rejects.toThrow("save boom");
  });

  test("a store whose save throws synchronously does not mask the turn's own error", async () => {
    const store = {
      ...createMemoryTranscriptStore(),
      save: (): Promise<void> => {
        throw new Error("save boom");
      },
    };
    const handle = await openNativeSession(state, "s", base({ transcriptStore: store }));
    const failing = runNativeTurn(handle, "one", opts, {
      sessionState: state,
      complete: async () => {
        throw new Error("provider boom");
      },
    });
    await expect(failing).rejects.toThrow("provider boom");
  });

  test("reopening a name with a store drops the directory it was opened with before", async () => {
    await openNativeSession(state, "s", base({ transcriptDir: workdir }));
    await openNativeSession(state, "s", base({ transcriptStore: createMemoryTranscriptStore() }));
    expect(state.transcriptDirs.has("s")).toBe(false);
  });
});
