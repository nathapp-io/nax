import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { archiveTranscript } from "#src/native/session/transcript-archive";
import { transcriptImagesPath } from "#src/native/session/transcript-images";
import { createFileTranscriptStore, saveTranscript, transcriptPath } from "#src/native/session/transcript-store";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("nax-transcript-modes-");
});
afterEach(() => cleanupTempDir(dir));

const textMessages: ConversationMessage[] = [{ role: "user", content: "hello" }];
const imageMessages: ConversationMessage[] = [
  { role: "user", content: "look", images: [{ mimeType: "image/png", data: "AAAA" }] },
];

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("transcript file permissions", () => {
  test("AC-7: text transcript content is owner-only", async () => {
    await saveTranscript(dir, "s1", textMessages);
    expect(await modeOf(transcriptPath(dir, "s1"))).toBe(0o600);
  });

  test("AC-8: every published image is owner-only", async () => {
    await saveTranscript(dir, "s2", imageMessages);
    const imageDir = transcriptImagesPath(transcriptPath(dir, "s2"));
    const files = await readdir(imageDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await modeOf(join(imageDir, file))).toBe(0o600);
  });

  test("AC-9: archived transcript content is owner-only", async () => {
    const store = createFileTranscriptStore(dir);
    await store.save("s4", { savedAt: "2026-01-01T00:00:00.000Z", messages: textMessages });
    const archiveDir = join(dir, "archive");
    await archiveTranscript(store, "s4", { dir: archiveDir, maxRetained: 10 });
    const files = await readdir(archiveDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^s4\.transcript\..+\.json$/);
    expect(await modeOf(join(archiveDir, files[0] ?? "missing"))).toBe(0o600);
  });

  test("AC-11: replacing an existing 0644 transcript makes it owner-only", async () => {
    const path = transcriptPath(dir, "s3");
    await writeFile(path, "old transcript", { mode: 0o644 });
    await chmod(path, 0o644);
    expect(await modeOf(path)).toBe(0o644);
    await saveTranscript(dir, "s3", textMessages);
    expect(await modeOf(path)).toBe(0o600);
  });
});
