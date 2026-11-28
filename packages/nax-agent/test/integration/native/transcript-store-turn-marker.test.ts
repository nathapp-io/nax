import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageAttachment, TranscriptDoc, TurnMarker } from "@nathapp/nax-agent";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { _transcriptImagesDeps, transcriptImagesPath } from "#src/native/session/transcript-images";
import { createFileTranscriptStore, transcriptPath } from "#src/native/session/transcript-store";
import { assertDefined, cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("transcript-marker-");
});
afterEach(() => {
  cleanupTempDir(dir);
});

const msgs: ConversationMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi", thinking: [{ text: "pondering", signature: "sig-1" }] },
];

describe("file transcript turn markers", () => {
  test("markTurn on a missing session creates an empty document with the marker", async () => {
    const store = createFileTranscriptStore(dir);
    await store.markTurn("s", { turnId: "t1", state: "running" });
    const doc = await store.load("s");
    expect(doc?.messages).toEqual([]);
    expect(doc?.turn).toEqual({ turnId: "t1", state: "running" });
    expect(doc?.schemaVersion).toBeUndefined();
  });

  test("markTurn merges into an existing document and keeps its history and identity", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", { owner: "o", model: "p/m", savedAt: "t", messages: msgs });
    await store.markTurn("s", { turnId: "t1", state: "ended" });
    expect(await store.load("s")).toEqual({
      owner: "o",
      model: "p/m",
      savedAt: "t",
      messages: msgs,
      turn: { turnId: "t1", state: "ended" },
    });
  });

  test("markTurn on a corrupt file throws TRANSCRIPT_CORRUPT", async () => {
    await writeFile(transcriptPath(dir, "bad"), "{not json");
    await expect(
      createFileTranscriptStore(dir).markTurn("bad", { turnId: "t", state: "running" }),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_CORRUPT" });
  });
});

/**
 * A stored image: a v2 document carries a content-addressed `ref` to a sidecar,
 * a pre-v2 one still carries the bytes inline.
 */
interface StoredImage {
  readonly ref?: string;
  readonly mimeType: string;
  readonly data?: string;
  readonly width?: number;
  readonly height?: number;
  readonly source?: string;
}

interface StoredMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly images?: readonly StoredImage[];
}

interface StoredDocument {
  readonly schemaVersion?: number;
  readonly owner?: string;
  readonly model?: string;
  readonly savedAt: string;
  readonly messages: readonly StoredMessage[];
  readonly turn?: TurnMarker;
}

/** One PNG referenced from a user prompt and a tool result: one ref, two occurrences. */
const sharedBytes = "AAAA";
const userImage: ImageAttachment = {
  mimeType: "image/png",
  data: sharedBytes,
  width: 10,
  height: 20,
  source: "clipboard",
};
const toolImage: ImageAttachment = { mimeType: "image/png", data: sharedBytes, width: 1, height: 3, source: "tool" };

const imageDoc: TranscriptDoc = {
  owner: "call-1",
  model: "anthropic/claude-x",
  savedAt: "2026-01-01T00:00:00.000Z",
  messages: [
    { role: "user", content: "look at this", images: [userImage] },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "Read", input: { path: "shot.png" } }] },
    { role: "tool-result", toolCallId: "c1", content: "shot", images: [toolImage] },
  ],
};

/**
 * Count every operation the image layer can perform — existence checks, path
 * resolution, reads and publication — until `stop()` restores the real seam.
 * Transcript JSON I/O does not go through this seam, so it is never counted.
 */
function countImageSeam(): { stop: () => readonly string[] } {
  const real = { ..._transcriptImagesDeps };
  const calls: string[] = [];
  const counted = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
    new Proxy(fn, {
      apply: (target, _thisArg, args) => {
        calls.push(name);
        return Reflect.apply(target, undefined, args);
      },
    });
  _transcriptImagesDeps.link = counted("link", real.link);
  _transcriptImagesDeps.mkdir = counted("mkdir", real.mkdir);
  _transcriptImagesDeps.open = counted("open", real.open);
  _transcriptImagesDeps.realpath = counted("realpath", real.realpath);
  _transcriptImagesDeps.lstat = counted("lstat", real.lstat);
  _transcriptImagesDeps.readFile = counted("readFile", real.readFile);
  _transcriptImagesDeps.rm = counted("rm", real.rm);
  _transcriptImagesDeps.stat = counted("stat", real.stat);
  _transcriptImagesDeps.writeFileAtomic = counted("writeFileAtomic", real.writeFileAtomic);
  return {
    stop: () => {
      Object.assign(_transcriptImagesDeps, real);
      return [...calls];
    },
  };
}

async function storedDocument(sessionId: string): Promise<StoredDocument> {
  const parsed: StoredDocument = JSON.parse(await readFile(transcriptPath(dir, sessionId), "utf8"));
  return parsed;
}

describe("turn markers on real transcript files (US-002)", () => {
  withDepsRestore(_transcriptImagesDeps);

  test("AC-1: running publishes the marker with zero image-sidecar operations", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", imageDoc);
    const counting = countImageSeam();
    await store.markTurn("s", { turnId: "t1", state: "running" });
    expect(counting.stop()).toEqual([]);
    expect((await storedDocument("s")).turn).toEqual({ turnId: "t1", state: "running" });
    // The counter itself is live: it sees the sidecar reads a hydrated load performs and
    // the work a save performs, so the empty reading above is the marker's doing.
    const hydrating = countImageSeam();
    await store.load("s");
    expect(hydrating.stop()).toContain("readFile");
    const saving = countImageSeam();
    await store.save("s", imageDoc);
    expect(saving.stop().length).toBeGreaterThan(0);
  });

  test("AC-1: ended after an intervening save publishes the marker with zero image-sidecar operations", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", imageDoc);
    await store.save("s", {
      ...imageDoc,
      messages: [...imageDoc.messages, { role: "assistant", content: "second" }],
    });
    const counting = countImageSeam();
    await store.markTurn("s", { turnId: "t2", state: "ended" });
    expect(counting.stop()).toEqual([]);
    expect((await storedDocument("s")).turn).toEqual({ turnId: "t2", state: "ended" });
  });

  test("AC-2: running rewrites only turn on the stored v2 document", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", imageDoc);
    const before = await storedDocument("s");
    await store.markTurn("s", { turnId: "t1", state: "running" });
    const after = await storedDocument("s");
    expect(after).toEqual({ ...before, turn: { turnId: "t1", state: "running" } });
    // The v2 refs, their duplication and their metadata survive byte-for-value.
    expect(after.schemaVersion).toBe(2);
    expect(after.owner).toBe("call-1");
    expect(after.model).toBe("anthropic/claude-x");
    expect(after.savedAt).toBe(before.savedAt);
    const userRef = after.messages[0]?.images?.[0];
    const resultRef = after.messages[2]?.images?.[0];
    expect(userRef?.ref).toMatch(/^[a-f0-9]{64}$/);
    expect(userRef?.ref).toBe(resultRef?.ref);
    expect(userRef).toMatchObject({ mimeType: "image/png", width: 10, height: 20, source: "clipboard" });
    expect(resultRef).toMatchObject({ mimeType: "image/png", width: 1, height: 3, source: "tool" });
  });

  test("AC-2: ended is based on the intervening save, not a snapshot from the turn's start", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", imageDoc);
    await store.save("s", {
      ...imageDoc,
      messages: [...imageDoc.messages, { role: "assistant", content: "changed" }],
    });
    const before = await storedDocument("s");
    await store.markTurn("s", { turnId: "t2", state: "ended" });
    const after = await storedDocument("s");
    expect(after).toEqual({ ...before, turn: { turnId: "t2", state: "ended" } });
    expect(after.messages).toHaveLength(4);
    expect(after.messages[3]).toMatchObject({ role: "assistant", content: "changed" });
  });

  test.each(["running", "ended"] as const)(
    "AC-3: %s with an absent sidecar keeps the refs and adds no missing-image note",
    async (state) => {
      const store = createFileTranscriptStore(dir);
      await store.save("s", imageDoc);
      const folder = transcriptImagesPath(transcriptPath(dir, "s"));
      const [sidecar] = await readdir(folder);
      assertDefined(sidecar, "the published image sidecar");
      await rm(join(folder, sidecar));
      const counting = countImageSeam();
      await store.markTurn("s", { turnId: "t9", state });
      expect(counting.stop()).toEqual([]);
      const stored = await storedDocument("s");
      expect(stored.turn).toEqual({ turnId: "t9", state });
      expect(stored.messages[0]?.images?.[0]?.ref).toBe(stored.messages[2]?.images?.[0]?.ref);
      expect(stored.messages[0]?.content).toBe("look at this");
      expect(JSON.stringify(stored)).not.toContain("[image missing");
      // Restoring the same sidecar makes load return the original image again, with no save.
      await writeFile(join(folder, sidecar), Buffer.from(sharedBytes, "base64"));
      expect((await store.load("s"))?.messages).toEqual(imageDoc.messages);
    },
  );

  test("AC-4: an absent transcript becomes a loadable empty document with a current savedAt", async () => {
    const store = createFileTranscriptStore(dir);
    const startedAt = Date.now();
    const marker: TurnMarker = { turnId: "t1", state: "running" };
    await store.markTurn("new", marker);
    const doc = await store.load("new");
    expect(doc?.messages).toEqual([]);
    expect(doc?.turn).toEqual(marker);
    expect(doc?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const savedAt = Date.parse(doc?.savedAt ?? "");
    expect(savedAt).toBeGreaterThanOrEqual(startedAt);
    expect(savedAt - startedAt).toBeLessThan(60_000);
    // Windows reports a synthetic mode; 0o600 is the POSIX contract.
    const mode = (await stat(transcriptPath(dir, "new"))).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  test("AC-5: a legacy bare array is wrapped with the epoch savedAt, its images left inline", async () => {
    const store = createFileTranscriptStore(dir);
    const legacy: ConversationMessage[] = [
      { role: "user", content: "old", images: [userImage] },
      { role: "assistant", content: "reply" },
    ];
    await writeFile(transcriptPath(dir, "legacy"), JSON.stringify(legacy), "utf8");
    const counting = countImageSeam();
    await store.markTurn("legacy", { turnId: "t1", state: "ended" });
    expect(counting.stop()).toEqual([]);
    const stored = await storedDocument("legacy");
    expect(stored).toEqual({
      savedAt: "1970-01-01T00:00:00.000Z",
      messages: legacy,
      turn: { turnId: "t1", state: "ended" },
    });
    expect(stored).not.toHaveProperty("schemaVersion");
    // Nothing was published to a sidecar, so the inline image is still inline.
    expect(await readdir(dir)).toEqual(["legacy.transcript.json"]);
    expect(stored.messages[0]?.images?.[0]).toMatchObject({ data: sharedBytes });
  });

  test.each([undefined, 1] as const)(
    "AC-6: a text-only document with schemaVersion %s keeps its fields apart from turn",
    async (schemaVersion) => {
      const store = createFileTranscriptStore(dir);
      const body = {
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
        owner: "o",
        savedAt: "2026-02-02T00:00:00.000Z",
        messages: [{ role: "user", content: "plain" }],
      };
      await writeFile(transcriptPath(dir, "doc"), JSON.stringify(body, null, 2), "utf8");
      await store.markTurn("doc", { turnId: "t1", state: "running" });
      const stored = await storedDocument("doc");
      expect(stored).toEqual({ ...body, turn: { turnId: "t1", state: "running" } });
      // Whether schemaVersion was present is part of what must not change.
      expect("schemaVersion" in stored).toBe(schemaVersion !== undefined);
    },
  );

  test.each([undefined, 1] as const)(
    "AC-6: an accepted document with schemaVersion %s and no messages keeps having no messages",
    async (schemaVersion) => {
      const store = createFileTranscriptStore(dir);
      const body = {
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
        owner: "o",
        savedAt: "2026-02-02T00:00:00.000Z",
      };
      await writeFile(transcriptPath(dir, "bare"), JSON.stringify(body, null, 2), "utf8");
      await store.markTurn("bare", { turnId: "t1", state: "running" });
      const stored = await storedDocument("bare");
      expect(stored).toMatchObject({ ...body, turn: { turnId: "t1", state: "running" } });
      expect(stored.savedAt).toBe(body.savedAt);
      expect(stored.owner).toBe("o");
      // An absent messages field is a stored field too: the marker changes only `turn`.
      expect("messages" in stored).toBe(false);
      expect("schemaVersion" in stored).toBe(schemaVersion !== undefined);
      // Still loadable, and still the same empty history the loader gives a missing field.
      expect((await store.load("bare"))?.messages).toEqual([]);
    },
  );

  test.each(["{not json", "null", "42", '"x"', "true"])(
    "AC-7: %s rejects TRANSCRIPT_CORRUPT and leaves the original bytes",
    async (body) => {
      const store = createFileTranscriptStore(dir);
      await writeFile(transcriptPath(dir, "bad"), body, "utf8");
      const counting = countImageSeam();
      await expect(store.markTurn("bad", { turnId: "t1", state: "running" })).rejects.toMatchObject({
        code: "TRANSCRIPT_CORRUPT",
      });
      expect(counting.stop()).toEqual([]);
      expect(await readFile(transcriptPath(dir, "bad"), "utf8")).toBe(body);
    },
  );

  test("AC-8: a schemaVersion above 2 rejects TRANSCRIPT_SCHEMA_UNSUPPORTED without overwriting", async () => {
    const store = createFileTranscriptStore(dir);
    const body = JSON.stringify({ schemaVersion: 3, savedAt: "t", messages: [] }, null, 2);
    await writeFile(transcriptPath(dir, "future"), body, "utf8");
    const counting = countImageSeam();
    await expect(store.markTurn("future", { turnId: "t1", state: "running" })).rejects.toMatchObject({
      code: "TRANSCRIPT_SCHEMA_UNSUPPORTED",
    });
    expect(counting.stop()).toEqual([]);
    expect(await readFile(transcriptPath(dir, "future"), "utf8")).toBe(body);
  });

  test.each(["user", "tool-result"] as const)(
    "AC-9: a v2 %s image list that is a string rejects TRANSCRIPT_CORRUPT without touching the file",
    async (role) => {
      const store = createFileTranscriptStore(dir);
      const message =
        role === "user" ? { role, content: "x", images: "ab" } : { role, toolCallId: "c1", content: "x", images: "ab" };
      const body = JSON.stringify({ schemaVersion: 2, savedAt: "t", messages: [message] }, null, 2);
      await writeFile(transcriptPath(dir, "lists"), body, "utf8");
      const counting = countImageSeam();
      await expect(store.markTurn("lists", { turnId: "t1", state: "running" })).rejects.toMatchObject({
        code: "TRANSCRIPT_CORRUPT",
      });
      expect(counting.stop()).toEqual([]);
      expect(await readFile(transcriptPath(dir, "lists"), "utf8")).toBe(body);
    },
  );

  test("AC-10: an injected failure before atomic rename leaves the previous JSON at its path", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s", imageDoc);
    const before = await readFile(transcriptPath(dir, "s"), "utf8");
    const realRename = _atomicWriteDeps.rename;
    _atomicWriteDeps.rename = async () => {
      throw new Error("rename denied");
    };
    try {
      await expect(store.markTurn("s", { turnId: "t1", state: "ended" })).rejects.toThrow("rename denied");
    } finally {
      _atomicWriteDeps.rename = realRename;
    }
    expect(await readFile(transcriptPath(dir, "s"), "utf8")).toBe(before);
    expect(await store.load("s")).toEqual(imageDoc);
  });

  test.each([null, { not: "an array" }, "a string"] as const)(
    "AC-11: a v2 messages container of %p rejects before publication, with no sidecar operation",
    async (messages) => {
      const store = createFileTranscriptStore(dir);
      const body = JSON.stringify({ schemaVersion: 2, savedAt: "t", messages }, null, 2);
      await writeFile(transcriptPath(dir, "msgs"), body, "utf8");
      const counting = countImageSeam();
      await expect(store.markTurn("msgs", { turnId: "t1", state: "running" })).rejects.toMatchObject({
        code: "TRANSCRIPT_CORRUPT",
      });
      expect(counting.stop()).toEqual([]);
      expect(await readFile(transcriptPath(dir, "msgs"), "utf8")).toBe(body);
    },
  );
});
