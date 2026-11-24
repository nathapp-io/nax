/**
 * Failure retention bounds only the archives it creates
 * (`pruneRetainedTranscripts(dir, cap, { archivesOnly: true })`).
 *
 * Kept apart from `transcript-store.test.ts` so that file stays under the split
 * threshold: the fixture here holds dozens of LIVE documents at once, because
 * the regression is that one failed resume deleted another live chat's document
 * (review e684, finding 2). Live names are bounded by the feature-startup sweep
 * (`sweepFeatureTranscripts`), which prunes without the option.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import {
  createFileTranscriptStore,
  MAX_RETAINED_TRANSCRIPTS,
  pruneRetainedTranscripts,
  retainTranscript,
  saveTranscript,
  transcriptPath,
} from "#src/native/session/transcript-store";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const DAY_MS = 86_400_000;
const SESSION_COUNT = 51;
const BASE_MTIME_MS = new Date(2026, 0, 1).getTime();
const ARCHIVE_JSON = /\.transcript\.failed-.*\.json$/;

const msgs: ConversationMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];
const images: ConversationMessage[] = [
  { role: "user", content: "x", images: [{ mimeType: "image/png", data: "AAAA" }] },
];

let dir: string;
beforeEach(() => {
  dir = makeTempDir("nax-transcript-archives-");
});
afterEach(() => {
  cleanupTempDir(dir);
});

function sessionName(n: number): string {
  return `s-${String(n).padStart(2, "0")}`;
}

/** Give one file an explicit mtime — ranking is by mtime, never by write order. */
async function setMtime(path: string, ms: number): Promise<void> {
  const at = new Date(ms);
  await utimes(path, at, at);
}

/**
 * `s-01` (oldest) through `s-<count>`, saved live and a day apart, so the
 * oldest name is unambiguous. `withImagesOn` gives that one a `.transcript.images`
 * sidecar.
 */
async function seedLiveDocuments(count: number, withImagesOn?: string): Promise<void> {
  for (let n = 1; n <= count; n++) {
    const name = sessionName(n);
    await saveTranscript(dir, name, name === withImagesOn ? images : msgs);
    await setMtime(transcriptPath(dir, name), BASE_MTIME_MS + (n - 1) * DAY_MS);
  }
}

/** Save and immediately retain one document, returning the archive name it produced. */
async function makeArchive(name: string, mtimeMs: number): Promise<string> {
  await saveTranscript(dir, name, msgs);
  await retainTranscript(dir, name);
  const archive = (await readdir(dir)).find((entry) => entry.startsWith(`${name}.transcript.failed-`));
  if (archive === undefined) throw new Error(`retainTranscript produced no archive for ${name}`);
  await setMtime(join(dir, archive), mtimeMs);
  return archive;
}

function liveNames(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry.endsWith(".transcript.json")).sort();
}

function archiveNames(entries: readonly string[]): string[] {
  return entries.filter((entry) => ARCHIVE_JSON.test(entry)).sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1…AC-4: retainFailed over a directory of live documents must not evict one.
// ─────────────────────────────────────────────────────────────────────────────

describe("retainFailed — live documents are never pruned", () => {
  beforeEach(async () => {
    // s-01's sidecar makes AC-4's fixture: the oldest document is also the one
    // owning images, so a prune of live names would drop both of its files.
    await seedLiveDocuments(SESSION_COUNT, "s-01");
  });

  test("AC-1: an older live chat is still loadable after another chat's failed close", async () => {
    await createFileTranscriptStore(dir).retainFailed("s-51");

    expect(await createFileTranscriptStore(dir).load("s-01")).not.toBeNull();
  });

  test("AC-2: all 50 remaining live documents stay on disk", async () => {
    await createFileTranscriptStore(dir).retainFailed("s-51");

    const expected = Array.from({ length: SESSION_COUNT - 1 }, (_, i) => `${sessionName(i + 1)}.transcript.json`);
    expect(liveNames(await readdir(dir))).toEqual(expected);
  });

  test("AC-3: exactly one kept-on-failure archive for the retained session", async () => {
    await createFileTranscriptStore(dir).retainFailed("s-51");

    const entries = await readdir(dir);
    expect(
      entries.filter((entry) => entry.startsWith("s-51.transcript.failed-") && entry.endsWith(".json")),
    ).toHaveLength(1);
    // 50 live documents plus that one archive: nothing else was deleted (the
    // s-01 image sidecar is a folder, so it is not counted here).
    expect(entries.filter((entry) => entry.endsWith(".json"))).toHaveLength(SESSION_COUNT);
    expect(archiveNames(entries)).toHaveLength(1);
  });

  test("AC-4: the oldest live document's image sidecar survives", async () => {
    await createFileTranscriptStore(dir).retainFailed("s-51");

    expect(await readdir(dir)).toContain("s-01.transcript.images");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5…AC-7: the archive cap still holds when there are more archives than it.
// ─────────────────────────────────────────────────────────────────────────────

describe("retainFailed — the archive cap still bounds retained archives", () => {
  const ARCHIVE_COUNT = MAX_RETAINED_TRANSCRIPTS;
  const liveOld = "live-old";
  const liveKeep = "live-keep";
  let oldestArchive: string;

  beforeEach(async () => {
    // Archives a day apart, all newer than the unrelated live document and
    // older than the one about to be retained.
    for (let n = 1; n <= ARCHIVE_COUNT; n++) {
      const archived = await makeArchive(`arch-${String(n).padStart(2, "0")}`, BASE_MTIME_MS + n * DAY_MS);
      if (n === 1) oldestArchive = archived;
    }
    await saveTranscript(dir, liveOld, msgs);
    await setMtime(transcriptPath(dir, liveOld), BASE_MTIME_MS - DAY_MS);
    await saveTranscript(dir, liveKeep, msgs);
    await setMtime(transcriptPath(dir, liveKeep), BASE_MTIME_MS + (ARCHIVE_COUNT + 1) * DAY_MS);
  });

  test("AC-5: retaining one live document leaves exactly the archive cap in archives", async () => {
    await createFileTranscriptStore(dir).retainFailed(liveKeep);

    expect(archiveNames(await readdir(dir))).toHaveLength(ARCHIVE_COUNT);
  });

  test("AC-6: the oldest archive by mtime is the one deleted", async () => {
    await createFileTranscriptStore(dir).retainFailed(liveKeep);

    const entries = await readdir(dir);
    expect(entries).not.toContain(oldestArchive);
    // The document being retained became the newest archive, so it survives.
    expect(entries.filter((entry) => entry.startsWith(`${liveKeep}.transcript.failed-`))).toHaveLength(1);
  });

  test("AC-7: the other live document is still loadable", async () => {
    await createFileTranscriptStore(dir).retainFailed(liveKeep);

    expect(await createFileTranscriptStore(dir).load(liveOld)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8…AC-12: pruneRetainedTranscripts' own contract, with and without the option.
// ─────────────────────────────────────────────────────────────────────────────

describe("pruneRetainedTranscripts — archivesOnly", () => {
  async function seedTwoLiveTwoArchived(): Promise<void> {
    await saveTranscript(dir, "live-a", msgs);
    await setMtime(transcriptPath(dir, "live-a"), BASE_MTIME_MS);
    await saveTranscript(dir, "live-b", msgs);
    await setMtime(transcriptPath(dir, "live-b"), BASE_MTIME_MS + DAY_MS);
    await makeArchive("arch-a", BASE_MTIME_MS + 2 * DAY_MS);
    await makeArchive("arch-b", BASE_MTIME_MS + 3 * DAY_MS);
  }

  test("AC-8: returns the number of archives pruned, ignoring live documents", async () => {
    await seedTwoLiveTwoArchived();

    expect(await pruneRetainedTranscripts(dir, 1, { archivesOnly: true })).toBe(1);
  });

  test("AC-9: both live documents remain after an archives-only prune", async () => {
    await seedTwoLiveTwoArchived();

    await pruneRetainedTranscripts(dir, 1, { archivesOnly: true });

    expect(liveNames(await readdir(dir))).toEqual(["live-a.transcript.json", "live-b.transcript.json"]);
  });

  test("AC-10: without the option the oldest live document is still deleted", async () => {
    const names = ["live-c", "live-b", "live-a"];
    for (const [i, name] of names.entries()) {
      await saveTranscript(dir, name, msgs);
      await setMtime(transcriptPath(dir, name), BASE_MTIME_MS + i * DAY_MS);
    }

    await pruneRetainedTranscripts(dir, 2);

    // "live-c" carries the oldest mtime, so it is the one dropped.
    expect(liveNames(await readdir(dir))).toEqual(["live-a.transcript.json", "live-b.transcript.json"]);
  });

  test("AC-11: without the option the deleted count still comes back", async () => {
    for (const [i, name] of ["live-a", "live-b", "live-c"].entries()) {
      await saveTranscript(dir, name, msgs);
      await setMtime(transcriptPath(dir, name), BASE_MTIME_MS + i * DAY_MS);
    }

    expect(await pruneRetainedTranscripts(dir, 2)).toBe(1);
  });

  test("AC-12: a directory that does not exist returns 0 rather than throwing", async () => {
    expect(await pruneRetainedTranscripts(join(dir, "never-created"), 1, { archivesOnly: true })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13…AC-14: fewer archives than the cap deletes nothing, whatever the live count.
// ─────────────────────────────────────────────────────────────────────────────

describe("pruneRetainedTranscripts — fewer archives than the cap", () => {
  async function seedThreeArchivedTenLive(): Promise<void> {
    for (let n = 1; n <= 3; n++) {
      await makeArchive(`arch-${n}`, BASE_MTIME_MS + n * DAY_MS);
    }
    for (let n = 1; n <= 10; n++) {
      await saveTranscript(dir, `live-${String(n).padStart(2, "0")}`, msgs);
      await setMtime(transcriptPath(dir, `live-${String(n).padStart(2, "0")}`), BASE_MTIME_MS + n * DAY_MS);
    }
  }

  test("AC-13: returns 0", async () => {
    await seedThreeArchivedTenLive();

    expect(await pruneRetainedTranscripts(dir, 5, { archivesOnly: true })).toBe(0);
  });

  test("AC-14: deletes nothing", async () => {
    await seedThreeArchivedTenLive();
    const before = (await readdir(dir)).sort();

    await pruneRetainedTranscripts(dir, 5, { archivesOnly: true });

    expect((await readdir(dir)).sort()).toEqual(before);
    expect(before).toHaveLength(13);
  });
});
