/**
 * S3-1 (S3 spec 5.5): native sessions load and save through an injected
 * TranscriptStore, open refuses an ambiguous transcript source, and
 * `retainOnClose` leaves the live document in place on close.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  type NativeSessionState,
  openNativeSession,
} from "#src/native/session/session";
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
});
