import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";

const msgs: ConversationMessage[] = [{ role: "user", content: "hello" }];

describe("createMemoryTranscriptStore", () => {
  test("load is null until a save", async () => {
    expect(await createMemoryTranscriptStore().load("s")).toBeNull();
  });

  test("save then load round-trips; sessions are separate", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("a", { savedAt: "t", messages: msgs });
    expect(await store.load("a")).toEqual({ savedAt: "t", messages: msgs });
    expect(await store.load("b")).toBeNull();
  });

  test("mutating the saved array or a loaded document does not change stored history", async () => {
    const store = createMemoryTranscriptStore();
    const mine = [...msgs];
    await store.save("s", { savedAt: "t", messages: mine });
    mine.push({ role: "user", content: "later" });
    const loaded = await store.load("s");
    Reflect.apply(Array.prototype.push, loaded?.messages, [{ role: "user", content: "sneaky" }]);
    expect((await store.load("s"))?.messages).toEqual(msgs);
  });

  test("retainFailed moves the document out of load's reach and keeps a copy", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: "t", messages: msgs });
    await store.retainFailed("s");
    expect(await store.load("s")).toBeNull();
    expect(store.retained("s")?.messages).toEqual(msgs);
  });

  test("retainFailed and delete are safe on a missing session", async () => {
    const store = createMemoryTranscriptStore();
    await store.retainFailed("none");
    await store.delete("none");
    expect(store.retained("none")).toBeUndefined();
  });

  test("delete removes the live document", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: "t", messages: msgs });
    await store.delete("s");
    expect(await store.load("s")).toBeNull();
  });

  test("markTurn creates an empty document when none exists, then merges", async () => {
    const store = createMemoryTranscriptStore();
    await store.markTurn("s", { turnId: "t1", state: "running" });
    expect((await store.load("s"))?.turn).toEqual({ turnId: "t1", state: "running" });
    expect((await store.load("s"))?.messages).toEqual([]);
    await store.save("s", { owner: "o", savedAt: "t", messages: msgs });
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect(await store.load("s")).toEqual({
      owner: "o",
      savedAt: "t",
      messages: msgs,
      turn: { turnId: "t1", state: "ended" },
    });
  });
});
