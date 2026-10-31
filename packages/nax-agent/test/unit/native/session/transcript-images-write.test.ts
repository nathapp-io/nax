import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageAttachment } from "#src/cost/standard-types";
import { NaxError } from "#src/infra/index";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _transcriptImagesDeps } from "#src/native/session/transcript-images";
import { createFileTranscriptStore, saveTranscript, transcriptPath } from "#src/native/session/transcript-store";
import type { TranscriptDoc } from "#src/native/session/transcript-types";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

const bytes = Buffer.from([0, 1, 2, 255, 128]);
const hash = createHash("sha256").update(bytes).digest("hex");
const image: ImageAttachment = {
  mimeType: "image/png",
  data: bytes.toString("base64"),
  width: 10,
  height: 20,
  source: "clipboard",
};
const doc = (images: readonly ImageAttachment[] = [image]): TranscriptDoc => ({
  savedAt: "now",
  messages: [{ role: "user", content: "look", images }],
});
const empty: TranscriptDoc = { savedAt: "then", messages: [{ role: "user", content: "text" }] };
let dir: string;
const folder = () => join(dir, "s.transcript.images");
const disk = async () => JSON.parse(await readFile(transcriptPath(dir, "s"), "utf8"));
beforeEach(() => {
  dir = makeTempDir("transcript-images-");
});
afterEach(() => {
  cleanupTempDir(dir);
});

describe("file transcript image writes", () => {
  withDepsRestore(_atomicWriteDeps);
  withDepsRestore(_transcriptImagesDeps);

  test("AC9 concurrent saves never replace a published image", async () => {
    const finalPath = join(folder(), `${hash}.png`);
    const bothMissing = Promise.withResolvers<void>();
    const realStat = _transcriptImagesDeps.stat;
    let misses = 0;
    _transcriptImagesDeps.stat = async (path) => {
      try {
        return await realStat(path);
      } catch (error) {
        if (path !== finalPath || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
          throw error;
        misses++;
        if (misses === 2) bothMissing.resolve();
        await bothMissing.promise;
        throw error;
      }
    };
    const realRename = _atomicWriteDeps.rename;
    let replacements = 0;
    let publication = Promise.resolve();
    _atomicWriteDeps.rename = async (from, to) => {
      if (String(to) !== finalPath) return realRename(from, to);
      // Serialize final renames to make replacement observable, rather than timing-dependent.
      const previous = publication;
      const done = Promise.withResolvers<void>();
      publication = done.promise;
      await previous;
      try {
        try {
          await realStat(finalPath);
          replacements++;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
        await realRename(from, to);
      } finally {
        done.resolve();
      }
    };
    const realLink = _transcriptImagesDeps.link;
    let linkAttempts = 0;
    let publications = 0;
    _transcriptImagesDeps.link = async (from, to) => {
      linkAttempts++;
      await realLink(from, to);
      publications++;
    };
    const store = createFileTranscriptStore(dir);
    await Promise.all([store.save("s", doc()), createFileTranscriptStore(dir).save("s", doc())]);
    expect(misses).toBe(2);
    expect(replacements).toBe(0);
    expect(linkAttempts).toBe(2);
    expect(publications).toBe(1);
    expect((await realStat(finalPath)).nlink).toBe(1);
    expect(await readdir(folder())).toEqual([`${hash}.png`]);
    expect(await readFile(finalPath)).toEqual(bytes);
    expect(await store.load("s")).toEqual(doc());
  });
  test.each([
    ["AC1 content-addressed PNG", async () => expect(await readdir(folder())).toEqual([`${hash}.png`])],
    ["AC2 raw bytes", async () => expect(await readFile(join(folder(), `${hash}.png`))).toEqual(bytes)],
    ["AC3 ref", async () => expect((await disk()).messages[0].images[0].ref).toBe(hash)],
    ["AC4 no inline data", async () => expect((await disk()).messages[0].images[0]).not.toHaveProperty("data")],
    [
      "AC5 metadata",
      async () =>
        expect((await disk()).messages[0].images[0]).toMatchObject({
          mimeType: image.mimeType,
          width: 10,
          height: 20,
          source: "clipboard",
        }),
    ],
    ["AC6 disk version", async () => expect((await disk()).schemaVersion).toBe(2)],
  ])("%s", async (_name, check) => {
    await createFileTranscriptStore(dir).save("s", doc());
    await check();
  });
  test("AC7 AC8 image-free bytes and absent version/folder", async () => {
    await createFileTranscriptStore(dir).save("s", empty);
    expect(await readFile(transcriptPath(dir, "s"), "utf8")).toBe(JSON.stringify(empty, null, 2));
    expect(await disk()).not.toHaveProperty("schemaVersion");
    expect(await readdir(dir)).toEqual(["s.transcript.json"]);
    await createFileTranscriptStore(dir).save("s", { ...empty, schemaVersion: 1 });
    expect((await disk()).schemaVersion).toBe(1);
  });
  test("AC9 deduplicates and never rewrites existing bytes", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", { ...doc(), messages: [...doc().messages, ...doc().messages] });
    expect(await readdir(folder())).toEqual([`${hash}.png`]);
    const realWrite = _atomicWriteDeps.writeFile;
    _atomicWriteDeps.writeFile = async (path, content, options) => {
      expect(path.startsWith(folder())).toBe(false);
      await realWrite(path, content, options);
    };
    await store.save("s", doc());
    await store.markTurn("s", { turnId: "t", state: "ended" });
    expect(await store.load("s")).toEqual({ ...doc(), turn: { turnId: "t", state: "ended" } });
  });
  test.each([
    ["image/jpeg", "jpg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ])("AC10-12 %s extension", async (mimeType, ext) => {
    await createFileTranscriptStore(dir).save("s", doc([{ ...image, mimeType }]));
    expect(await readdir(folder())).toEqual([`${hash}.${ext}`]);
  });
  test("AC13 AC14 preflights all MIME declarations before any writes", async () => {
    const saving = createFileTranscriptStore(dir).save("s", doc([image, { ...image, mimeType: "image/bmp" }]));
    await expect(saving).rejects.toBeInstanceOf(NaxError);
    await expect(saving).rejects.toMatchObject({
      code: "TRANSCRIPT_IMAGE_TYPE_UNSUPPORTED",
      context: { stage: "native-session" },
    });
    expect(await readdir(dir)).toEqual([]);
  });
  test("AC15 occupied folder preserves previous JSON", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", empty);
    const previous = await readFile(transcriptPath(dir, "s"), "utf8");
    await writeFile(folder(), "occupied");
    await expect(store.save("s", doc())).rejects.toThrow();
    expect(await readFile(transcriptPath(dir, "s"), "utf8")).toBe(previous);
  });
  test("AC16 saveTranscript uses sidecars", async () => {
    await saveTranscript(dir, "s", doc().messages);
    expect(await readdir(folder())).toEqual([`${hash}.png`]);
    expect((await disk()).messages[0].images[0].ref).toBe(hash);
  });
  test("AC17 recomputes version after images disappear", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", doc());
    expect((await disk()).schemaVersion).toBe(2);
    await store.save("s", empty);
    expect(await disk()).not.toHaveProperty("schemaVersion");
    expect(await readdir(folder())).toEqual([`${hash}.png`]);
  });
  test("AC18 failed staged rename cleans up and retry round-trips", async () => {
    const store = createFileTranscriptStore(dir);
    const realRename = _atomicWriteDeps.rename;
    let failed = false;
    _atomicWriteDeps.rename = async (from, to) => {
      if (String(to).startsWith(folder()) && !failed) {
        failed = true;
        throw new Error("rename failed");
      }
      await realRename(from, to);
    };
    await expect(store.save("s", doc())).rejects.toThrow("rename failed");
    expect(await readdir(folder())).toEqual([]);
    expect(await store.load("s")).toBeNull();
    await store.save("s", doc());
    expect(await store.load("s")).toEqual(doc());
    expect(await readdir(folder())).toEqual([`${hash}.png`]);
  });
  test("AC19 AC20 partial write preserves original error and leaves no final or temp file", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", empty);
    const previous = await readFile(transcriptPath(dir, "s"), "utf8");
    const realWrite = _atomicWriteDeps.writeFile;
    const error = new Error("ENOSPC");
    _atomicWriteDeps.writeFile = async (path, content, options) => {
      if (path.startsWith(folder())) {
        await realWrite(path, content.slice(0, 2), options);
        throw error;
      }
      await realWrite(path, content, options);
    };
    await expect(store.save("s", doc())).rejects.toBe(error);
    expect(await readdir(folder())).toEqual([]);
    expect(await readFile(transcriptPath(dir, "s"), "utf8")).toBe(previous);
  });
  test("memory store keeps images inline", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", doc());
    expect(await store.load("s")).toEqual(doc());
  });
});
