import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageAttachment, TranscriptDoc } from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/index";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _transcriptImagesDeps, transcriptImagesPath } from "#src/native/session/transcript-images";
import { createFileTranscriptStore, transcriptPath } from "#src/native/session/transcript-store";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { assertDefined, cleanupTempDir, installImageClient, makeTempDir } from "#test/helpers/index";

const image: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 10, height: 20, source: "clipboard" };
const doc: TranscriptDoc = { savedAt: "t", messages: [{ role: "user", content: "x", images: [image] }] };
let dir: string;
const realRead = _transcriptImagesDeps.readFile;
const realOpen = _transcriptImagesDeps.open;
beforeEach(() => {
  dir = makeTempDir("transcript-read-");
});
afterEach(() => {
  _transcriptImagesDeps.readFile = realRead;
  _transcriptImagesDeps.open = realOpen;
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
  test("B1: a symlinked sidecar rejects save without replacing the previous transcript", async () => {
    const store = createFileTranscriptStore(dir);
    const previous: TranscriptDoc = { savedAt: "old", messages: [{ role: "user", content: "keep" }] };
    await store.save("s", previous);
    const path = transcriptPath(dir, "s");
    const before = await readFile(path, "utf8");
    const outside = join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, transcriptImagesPath(path));
    await expect(store.save("s", doc)).rejects.toMatchObject({ code: "TRANSCRIPT_IMAGE_PATH_UNSAFE" });
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await store.load("s")).toEqual(previous);
    await rm(transcriptImagesPath(path));
    await store.save("s", doc);
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect((await store.load("s"))?.messages).toEqual(doc.messages);
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
  test("US-001 AC-1/4: marks the missing second image by its stored position and keeps survivors ordered", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc);
    const path = transcriptPath(dir, "s");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      messages: Array<{ images: object[] }>;
    };
    const first = saved.messages[0]?.images[0];
    await stored([first ?? {}, { ref: "b".repeat(64), mimeType: "image/png" }]);
    expect((await store.load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing #2]", images: [image] },
    ]);
  });
  test("US-001 AC-2: numbers each missing image by its stored position", async () => {
    await stored([
      { ref: "a".repeat(64), mimeType: "image/png" },
      { ref: "b".repeat(64), mimeType: "image/png" },
    ]);
    expect((await createFileTranscriptStore(dir).load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing #1]\n[image missing #2]" },
    ]);
  });
  test("US-001 AC-4: keeps images around a missing slot in their original order", async () => {
    const store = createFileTranscriptStore(dir);
    const thirdImage: ImageAttachment = { ...image, data: "BBBB", width: 30 };
    await store.save("s", { savedAt: "t", messages: [{ role: "user", content: "x", images: [image, thirdImage] }] });
    const path = transcriptPath(dir, "s");
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      messages: Array<{ images: object[] }>;
    };
    const storedImages = saved.messages[0]?.images ?? [];
    await stored([storedImages[0] ?? {}, { ref: "b".repeat(64), mimeType: "image/png" }, storedImages[1] ?? {}]);
    expect((await store.load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing #2]", images: [image, thirdImage] },
    ]);
  });
  test("US-001: a lost image keeps its original slot across a later load and save", async () => {
    const store = createFileTranscriptStore(dir);
    const second: ImageAttachment = { ...image, data: "BBBB", width: 20 };
    const third: ImageAttachment = { ...image, data: "CCCC", width: 30 };
    await store.save("s", { savedAt: "t", messages: [{ role: "user", content: "x", images: [image, second, third] }] });
    const path = transcriptPath(dir, "s");
    // Each cycle loses the next survivor's file, so the slot a later loss is numbered against
    // is never the slot the array it comes from counts.
    const loseFirstStoredImage = async (): Promise<void> => {
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        messages: Array<{ images: Array<{ ref: string }> }>;
      };
      await rm(join(transcriptImagesPath(path), `${saved.messages[0]?.images[0]?.ref ?? ""}.png`));
    };
    await loseFirstStoredImage();
    const once = await store.load("s");
    expect(once?.messages).toEqual([{ role: "user", content: "x\n[image missing #1]", images: [second, third] }]);
    assertDefined(once, "the first load of the three-image transcript");
    await store.save("s", once);
    await loseFirstStoredImage();
    // The survivor that was original #2 is gone, so original #3 is still image 3 rather than
    // the next number the two-image array would have given it.
    expect((await store.load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing #1]\n[image missing #2]", images: [third] },
    ]);
  });
  test("US-001: a bare note from an older build names no slot", async () => {
    // A pre-numbering note records no position, so it cannot shift the survivors' slots: the one
    // stored image, now unreadable too, is numbered from the start.
    await writeFile(
      transcriptPath(dir, "s"),
      JSON.stringify({
        schemaVersion: 2,
        savedAt: "t",
        messages: [
          { role: "user", content: "x\n[image missing]", images: [{ ref: "a".repeat(64), mimeType: "image/png" }] },
        ],
      }),
    );
    expect((await createFileTranscriptStore(dir).load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing]\n[image missing #1]" },
    ]);
  });
  test("US-001: a stored image list that is not an array is a corrupt transcript", async () => {
    await writeFile(
      transcriptPath(dir, "s"),
      JSON.stringify({ schemaVersion: 2, savedAt: "t", messages: [{ role: "user", content: "x", images: "ab" }] }),
    );
    const result = createFileTranscriptStore(dir).load("s");
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toMatchObject({ code: "TRANSCRIPT_CORRUPT", context: { stage: "native-session" } });
  });
  test("AC-6: recovers after an image file is deleted", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc);
    const folder = transcriptImagesPath(transcriptPath(dir, "s"));
    for (const name of await readdir(folder)) await rm(join(folder, name));
    expect((await store.load("s"))?.messages).toEqual([{ role: "user", content: "x\n[image missing #1]" }]);
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
      { role: "user", content: "x\n[image missing #1]" },
    ]);
    expect(reads).toBe(0);
  });
  test.each(["file", "folder"] as const)("F1: refuses an outside %s symlink", async (target) => {
    const folder = transcriptImagesPath(transcriptPath(dir, "s"));
    const ref = "a".repeat(64);
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, `${ref}.png`), "private bytes");
    if (target === "file") {
      await mkdir(folder);
      await symlink(join(outside, `${ref}.png`), join(folder, `${ref}.png`));
    } else {
      await symlink(outside, folder);
    }
    await stored([{ ref, mimeType: "image/png" }]);
    expect((await createFileTranscriptStore(dir).load("s"))?.messages).toEqual([
      { role: "user", content: "x\n[image missing #1]" },
    ]);
  });
  test("F1: a folder redirected during open is rejected before bytes are read", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc);
    const folder = transcriptImagesPath(transcriptPath(dir, "s"));
    const outside = join(dir, "outside");
    await mkdir(outside);
    for (const name of await readdir(folder)) await writeFile(join(outside, name), "private bytes");
    _transcriptImagesDeps.open = async (...args) => {
      await rename(folder, `${folder}.original`);
      await symlink(outside, folder);
      return realOpen(...args);
    };
    let reads = 0;
    _transcriptImagesDeps.readFile = async (...args) => {
      reads++;
      return realRead(...args);
    };
    expect((await store.load("s"))?.messages).toEqual([{ role: "user", content: "x\n[image missing #1]" }]);
    expect(reads).toBe(0);
  });
  test("US-001 AC-3: missing images on empty content have no leading newline; valid images retain order", async () => {
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
    expect((await store.load("s"))?.messages).toEqual([
      { role: "user", content: "[image missing #1]", images: [image] },
    ]);
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
    try {
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
      }
    } finally {
      client.restore();
    }
  });
  test("AC-18: memory store keeps image data unchanged", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", doc);
    expect(await store.load("s")).toEqual(doc);
  });
});
