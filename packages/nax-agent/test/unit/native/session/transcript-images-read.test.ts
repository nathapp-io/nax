import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageAttachment, TranscriptDoc } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/index";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _transcriptImagesDeps, transcriptImagesPath } from "#src/native/session/transcript-images";
import { createFileTranscriptStore, transcriptPath } from "#src/native/session/transcript-store";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { cleanupTempDir, installImageClient, makeTempDir } from "#test/helpers/index";

const image: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 10, height: 20, source: "clipboard" };
const doc: TranscriptDoc = { savedAt: "t", messages: [{ role: "user", content: "x", images: [image] }] };
let dir: string;
const realRead = _transcriptImagesDeps.readFile;
beforeEach(() => {
  dir = makeTempDir("transcript-read-");
});
afterEach(() => {
  _transcriptImagesDeps.readFile = realRead;
  cleanupTempDir(dir);
});

async function stored(images: readonly object[], content = "x") {
  await writeFile(
    transcriptPath(dir, "s"),
    JSON.stringify({ schemaVersion: 2, savedAt: "t", messages: [{ role: "user", content, images }] }),
  );
}

describe("file transcript image reads", () => {
  test("AC-1/2/3: round-trips inline images without ref or disk version", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc);
    const loaded = await store.load("s");
    expect(loaded?.messages).toEqual(doc.messages);
    const user = loaded?.messages[0];
    expect(user?.role === "user" && user.images?.[0]).not.toHaveProperty("ref");
    expect(loaded).not.toHaveProperty("schemaVersion");
  });
  test.each([1, undefined] as const)("AC-4/11: preserves legacy version %s", async (schemaVersion) => {
    const legacy: TranscriptDoc = {
      ...(schemaVersion === 1 ? { schemaVersion } : {}),
      savedAt: "t",
      messages: [{ role: "user", content: "old" }],
    };
    const store = createFileTranscriptStore(dir);
    await store.save("s", legacy);
    expect(await store.load("s")).toEqual(legacy);
  });
  test("AC-5: appends a missing note for each image", async () => {
    await stored([
      { ref: "a".repeat(64), mimeType: "image/png" },
      { ref: "b".repeat(64), mimeType: "image/png" },
    ]);
    expect((await createFileTranscriptStore(dir).load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing]\n[image missing]" },
    ]);
  });
  test("AC-6: recovers after an image file is deleted", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc);
    const folder = transcriptImagesPath(transcriptPath(dir, "s"));
    for (const name of await readdir(folder)) await rm(join(folder, name));
    expect((await store.load("s"))?.messages).toEqual([{ role: "user", content: "x\n[image missing]" }]);
  });
  test.each([
    ["AC-7/8", "../escape", "image/png"],
    ["AC-9", "a".repeat(64), "text/plain"],
    ["uppercase ref", "A".repeat(64), "image/png"],
    ["prototype MIME", "a".repeat(64), "constructor"],
  ])("%s: rejects unsafe metadata before any file read", async (_ac, ref, mimeType) => {
    await writeFile(join(dir, "escape.png"), "secret");
    await stored([{ ref, mimeType }]);
    let reads = 0;
    _transcriptImagesDeps.readFile = async (...args) => {
      reads++;
      return realRead(...args);
    };
    expect((await createFileTranscriptStore(dir).load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing]" },
    ]);
    expect(reads).toBe(0);
  });
  test("missing images on empty content have no leading newline; valid images retain order", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc);
    const { createHash } = await import("node:crypto");
    const ref = createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
    const { data: _data, ...metadata } = image;
    await stored(
      [
        { ref: "bad", mimeType: "image/png" },
        { ...metadata, ref },
      ],
      "",
    );
    expect((await store.load("s"))?.messages).toEqual([{ role: "user", content: "[image missing]", images: [image] }]);
  });
  test("AC-10: rejects future disk schemas with the native error", async () => {
    await writeFile(transcriptPath(dir, "s"), JSON.stringify({ ...doc, schemaVersion: 3 }));
    const result = createFileTranscriptStore(dir).load("s");
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({
      code: "TRANSCRIPT_SCHEMA_UNSUPPORTED",
      context: { stage: "native-session" },
    });
  });
  test("AC-12: markTurn preserves loadable images", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc);
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect((await store.load("s"))?.messages).toEqual(doc.messages);
  });
  test("AC-13: native turn resumes image history through the file store", async () => {
    const client = installImageClient(["text", "image"]);
    const store = createFileTranscriptStore(dir);
    const adapter = new NativeSessionAdapter([], { ownClient: true });
    const handle = await adapter.openSession("images", {
      agentName: "native",
      workdir: dir,
      transcriptStore: store,
      timeoutSeconds: 60,
      modelDef: { provider: "ignored", model: "stub/stub-model" },
      resolvedPermissions: { mode: "default", bashApproval: "raw" },
    });
    try {
      await store.save(handle.id, doc);
      await adapter.sendTurn(handle, "next", { interactionHandler: { onInteraction: async () => null } });
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]?.messages).toContainEqual(doc.messages[0]);
    } finally {
      await adapter.closeSession(handle);
      client.restore();
    }
  });
  test("AC-18: memory store keeps image data unchanged", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", doc);
    expect(await store.load("s")).toEqual(doc);
  });
});
