// RE-ARCH: keep
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import {
  deleteTranscript,
  loadTranscript,
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
