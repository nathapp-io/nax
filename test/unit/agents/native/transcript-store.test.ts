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
  retainTranscript,
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

  test("a transcript loads for the owner that saved it", async () => {
    await saveTranscript(dir, "sess-a", msgs, "call-1");
    expect(await loadTranscript(dir, "sess-a", "call-1")).toEqual(msgs);
  });

  test("a transcript saved by one owner does not load for another (nax#1877)", async () => {
    // The failure this encodes: an abandoned op invocation leaves a transcript
    // at the deterministic session name, and the next invocation of the same
    // name silently resumes 150k tokens of someone else's conversation.
    await saveTranscript(dir, "sess-a", msgs, "call-1");
    expect(await loadTranscript(dir, "sess-a", "call-2")).toEqual([]);
  });

  test("a legacy owner-less transcript is not resumed by an owned session", async () => {
    // Pre-upgrade transcripts are bare arrays. Unowned history is foreign
    // history: the safe direction is to drop it, not to inherit it.
    await writeFile(transcriptPath(dir, "sess-a"), JSON.stringify(msgs), "utf8");
    expect(await loadTranscript(dir, "sess-a", "call-1")).toEqual([]);
  });

  test("an owner-less reader still sees an owned transcript", async () => {
    // Callers that do not thread an owner (tests, non-op paths) keep working;
    // enforcement applies only when the reader actually declares an identity.
    await saveTranscript(dir, "sess-a", msgs, "call-1");
    expect(await loadTranscript(dir, "sess-a")).toEqual(msgs);
  });

  test("retainTranscript moves the file off the loadable path", async () => {
    await saveTranscript(dir, "sess-a", msgs, "call-1");
    await retainTranscript(dir, "sess-a");
    // Still on disk for a human to read...
    const kept = (await readdir(dir)).filter((n) => n.startsWith("sess-a.transcript.failed-"));
    expect(kept).toHaveLength(1);
    // ...but no longer reachable by the next session of the same name.
    expect(await loadTranscript(dir, "sess-a", "call-1")).toEqual([]);
  });

  test("retainTranscript is safe when there is nothing to retain", async () => {
    await expect(retainTranscript(dir, "sess-none")).resolves.toBeUndefined();
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
    await expect(pruneRetainedTranscripts(join(dir, "missing"), 5)).resolves.toBe(0);
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

  test("prunes retained (failed) transcripts, which is the set that accumulates", async () => {
    for (const name of ["sess-a", "sess-b", "sess-c"]) {
      await saveTranscript(dir, name, msgs, "call-1");
      await retainTranscript(dir, name);
    }
    await pruneRetainedTranscripts(dir, 1);
    const remaining = (await readdir(dir)).filter((n) => n.includes(".transcript."));
    expect(remaining).toHaveLength(1);
  });

  test("exports the documented default cap", () => {
    expect(MAX_RETAINED_TRANSCRIPTS).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 AC1–AC3: pruneRetainedTranscripts returns Promise<number> — the count
// of deleted files. The existing describe block above asserted `undefined`
// (matching the old void return); the per-AC tests below pin the new contract.
// ─────────────────────────────────────────────────────────────────────────────

describe("pruneRetainedTranscripts — US-002 return value", () => {
  beforeEach(() => {
    _resetTranscriptTruncationWarningForTests();
  });

  test("AC1: returns 3 when 53 transcript files exceed maxRetained 50", async () => {
    // 53 > 50 → expect 3 deletions.
    for (let i = 0; i < 53; i++) {
      await saveTranscript(dir, `sess-${String(i).padStart(3, "0")}`, msgs);
    }

    const deleted = await pruneRetainedTranscripts(dir, 50);

    expect(deleted).toBe(3);
  });

  test("AC1: leaves exactly 50 files on disk after deleting the excess from 53", async () => {
    for (let i = 0; i < 53; i++) {
      await saveTranscript(dir, `sess-${String(i).padStart(3, "0")}`, msgs);
    }

    await pruneRetainedTranscripts(dir, 50);

    const remaining = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json"));
    expect(remaining).toHaveLength(50);
  });

  test("AC2: returns 0 when the directory holds fewer files than maxRetained", async () => {
    for (const name of ["sess-a", "sess-b", "sess-c"]) {
      await saveTranscript(dir, name, msgs);
    }
    const before = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json")).sort();

    const deleted = await pruneRetainedTranscripts(dir, 50);

    expect(deleted).toBe(0);
    const after = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json")).sort();
    expect(after).toEqual(before);
  });

  test("AC3: removes oldest transcripts first by mtime, leaving exactly maxRetained most-recent", async () => {
    // 5 transcripts spaced 1 day apart in mtime; cap=2 keeps the two newest.
    const names = ["t-2026-01-01", "t-2026-01-02", "t-2026-01-03", "t-2026-01-04", "t-2026-01-05"] as const;
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      await saveTranscript(dir, name, msgs);
      const mtime = new Date(2026, 0, 1 + i);
      await utimes(transcriptPath(dir, name), mtime, mtime);
    }

    const deleted = await pruneRetainedTranscripts(dir, 2);

    expect(deleted).toBe(3);
    const remaining = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json")).sort();
    expect(remaining).toEqual(["t-2026-01-04.transcript.json", "t-2026-01-05.transcript.json"]);
  });

  test("AC3 (boundary): returns 0 and keeps everything when count equals maxRetained", async () => {
    for (let i = 0; i < 50; i++) {
      await saveTranscript(dir, `sess-${String(i).padStart(3, "0")}`, msgs);
    }

    const deleted = await pruneRetainedTranscripts(dir, 50);

    expect(deleted).toBe(0);
    const remaining = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json"));
    expect(remaining).toHaveLength(50);
  });

  test("AC3 (boundary): deletes exactly 1 from a directory of 51 with maxRetained 50", async () => {
    for (let i = 0; i < 51; i++) {
      await saveTranscript(dir, `sess-${String(i).padStart(3, "0")}`, msgs);
    }

    const deleted = await pruneRetainedTranscripts(dir, 50);

    expect(deleted).toBe(1);
    const remaining = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json"));
    expect(remaining).toHaveLength(50);
  });

  test("AC9 prerequisite: returns 0 (not throws) when the directory does not exist", async () => {
    // The derived directory in setupRun may not exist yet on a fresh run;
    // sweepFeatureTranscripts delegates here, so this must be a safe no-op,
    // not a thrown ENOENT.
    const deleted = await pruneRetainedTranscripts(join(dir, "never-created"), 50);
    expect(deleted).toBe(0);
  });
});
