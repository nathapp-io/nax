// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import {
  _resetTranscriptTruncationWarningForTests,
  deleteTranscript,
  loadTranscript,
  MAX_RETAINED_TRANSCRIPTS,
  pruneRetainedTranscripts,
  saveTranscript,
  transcriptPath,
} from "@/agents/native/session/transcript-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-transcript-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const msgs: ConversationMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi", thinking: [{ text: "pondering", signature: "sig-1" }] },
];

describe("transcript store", () => {
  test("a session with no transcript loads as empty", async () => {
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
  });

  test("round-trips messages, preserving thinking blocks and their signatures", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    const back = await loadTranscript(dir, "sess-a");
    expect(back).toEqual(msgs);
    // The signature is what lets Anthropic thinking survive a turn.
    expect(back[1]).toMatchObject({ thinking: [{ signature: "sig-1" }] });
  });

  test("keeps sessions separate", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    expect(await loadTranscript(dir, "sess-b")).toEqual([]);
  });

  test("creates the directory when it does not exist", async () => {
    const nested = join(dir, "deep", "deeper");
    await saveTranscript(nested, "sess-a", msgs);
    expect(await loadTranscript(nested, "sess-a")).toEqual(msgs);
  });

  test("delete removes the transcript and is safe to repeat", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    await deleteTranscript(dir, "sess-a");
    expect(await loadTranscript(dir, "sess-a")).toEqual([]);
    await deleteTranscript(dir, "sess-a"); // must not throw
  });

  test("a corrupt transcript throws rather than silently starting over", async () => {
    await writeFile(transcriptPath(dir, "sess-a"), "{not json", "utf8");
    await expect(loadTranscript(dir, "sess-a")).rejects.toThrow();
  });
});

describe("pruneRetainedTranscripts", () => {
  beforeEach(() => {
    _resetTranscriptTruncationWarningForTests();
  });

  test("does nothing when the directory does not exist", async () => {
    await expect(pruneRetainedTranscripts(join(dir, "missing"), 5)).resolves.toBeUndefined();
  });

  test("does nothing when the count is at or below the cap", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    await saveTranscript(dir, "sess-b", msgs);
    await pruneRetainedTranscripts(dir, 2);
    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(["sess-a.transcript.json", "sess-b.transcript.json"]);
  });

  test("prunes to the N most recent, deleting the oldest first", async () => {
    // mtime, not filename or write order, drives the ranking — set it explicitly
    // so the ordering is deterministic regardless of write scheduling.
    const names = ["sess-old", "sess-mid", "sess-new"];
    for (const [i, name] of names.entries()) {
      await saveTranscript(dir, name, msgs);
      const mtime = new Date(2026, 0, 1 + i);
      await utimes(transcriptPath(dir, name), mtime, mtime);
    }

    await pruneRetainedTranscripts(dir, 2);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(["sess-mid.transcript.json", "sess-new.transcript.json"]);
  });

  test("ignores non-transcript files in the directory", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    await writeFile(join(dir, "descriptor.json"), "{}", "utf8");
    await pruneRetainedTranscripts(dir, 0);
    const remaining = await readdir(dir);
    expect(remaining).toContain("descriptor.json");
    expect(remaining).not.toContain("sess-a.transcript.json");
  });

  test("exports the documented default cap", () => {
    expect(MAX_RETAINED_TRANSCRIPTS).toBeGreaterThan(0);
  });
});
