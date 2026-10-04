import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileTranscriptStore, createMemoryTranscriptStore } from "#src/index";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-agent-node-transcript-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("transcript stores on Node", () => {
  test("file store round-trips a document and a turn marker", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", { owner: "o", savedAt: "t", messages: [{ role: "user", content: "hi" }] });
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect(await store.load("s")).toEqual({
      owner: "o",
      savedAt: "t",
      messages: [{ role: "user", content: "hi" }],
      turn: { turnId: "t1", state: "ended" },
    });
    expect(await readFile(join(dir, "s.transcript.json"), "utf8")).toContain('"turn"');
  });

  test("memory store copies documents (structuredClone on Node)", async () => {
    const store = createMemoryTranscriptStore();
    const doc = { savedAt: "t", messages: [{ role: "user" as const, content: "hi" }] };
    await store.save("s", doc);
    expect(await store.load("s")).toEqual(doc);
    expect(await store.load("s")).not.toBe(doc);
  });
});
