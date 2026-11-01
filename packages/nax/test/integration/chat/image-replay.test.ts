/**
 * The real seam between the transcript store and the transcript view: a document the file
 * store wrote, one of whose image files has since disappeared, loaded back and replayed.
 *
 * The store numbers the image it could not read (`[image missing #2]`, US-001). Replay must
 * read that number rather than renumbering what survived, or a resumed transcript would claim
 * the wrong picture is gone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFileTranscriptStore, type ImageAttachment } from "@nathapp/nax-agent";
import { transcriptPath } from "@nathapp/nax-agent/internal";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { imageNoteLabel } from "@/chat";
import { replayHistory } from "@/tui/chat/history-replay";

const SESSION = "images";
const CONTENT = "[Image #1] and [Image #2]";

/** A 2×3 PNG: the first image the message carried. */
const FIRST: ImageAttachment = { mimeType: "image/png", data: "AAAA", width: 2, height: 3, source: "clipboard" };
/** A 4×5 PNG with different bytes, so the store content-addresses it to its own file. */
const SECOND: ImageAttachment = { mimeType: "image/png", data: "AAAB", width: 4, height: 5, source: "clipboard" };

let dir: string;
beforeEach(() => {
  dir = makeTempDir("nax-image-replay-");
});
afterEach(() => {
  cleanupTempDir(dir);
});

/** The stored document, as the store wrote it: schemaVersion 2 and refs instead of inline data. */
async function storedDoc(): Promise<{
  readonly schemaVersion?: number;
  readonly messages: Array<{ readonly images?: Array<{ readonly ref?: string }> }>;
}> {
  return JSON.parse(await readFile(transcriptPath(dir, SESSION), "utf8"));
}

/** Delete the file the store published for the message's second image. */
async function deleteSecondImageFile(): Promise<void> {
  const doc = await storedDoc();
  const ref = doc.messages[0]?.images?.[1]?.ref;
  assertDefined(ref, "the store content-addressed the second image");
  const folder = transcriptPath(dir, SESSION).replace(/\.json$/, ".images");
  await rm(join(folder, `${ref}.png`), { force: true });
}

describe("replaying a transcript whose image file is gone", () => {
  test("US-004 AC-10: the lost image keeps its number instead of renumbering the survivor", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save(SESSION, {
      savedAt: "t",
      messages: [{ role: "user", content: CONTENT, images: [FIRST, SECOND] }],
    });
    expect((await storedDoc()).schemaVersion).toBe(2);
    await deleteSecondImageFile();

    const loaded = await store.load(SESSION);
    assertDefined(loaded, "the transcript loads");
    // The store's own numbering, which replay reads rather than recomputes.
    expect(loaded.messages).toEqual([{ role: "user", content: `${CONTENT}\n[image missing #2]`, images: [FIRST] }]);

    expect(replayHistory({ messages: loaded.messages, savedAt: loaded.savedAt })).toEqual([
      { kind: "user", text: CONTENT },
      { kind: "image", label: imageNoteLabel(1, FIRST) },
      { kind: "image", label: "image 2 · missing" },
    ]);
  });
});
