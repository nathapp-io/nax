/**
 * Conversation persistence for the native transport.
 *
 * nax-ai's client is stateless — every call takes the whole message array — so
 * nax keeps the conversation. Under ACP the acpx subprocess remembered it and
 * nax stored nothing; SessionDescriptor still has no message field, and gains
 * none. See ADR-028 sections 2 and 3.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";

export function transcriptPath(dir: string, sessionName: string): string {
  return join(dir, `${sessionName}.transcript.json`);
}

/** Missing file means a new conversation. Anything else is a real failure. */
export async function loadTranscript(dir: string, sessionName: string): Promise<ConversationMessage[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(dir, sessionName), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    return JSON.parse(raw) as ConversationMessage[];
  } catch (err) {
    // Deliberately not [] — silently restarting a conversation would drop the
    // history the model is mid-way through and look like a fresh session.
    throw new NaxError(
      `transcript for session "${sessionName}" is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      "TRANSCRIPT_CORRUPT",
      {
        stage: "native-session",
      },
    );
  }
}

export async function saveTranscript(
  dir: string,
  sessionName: string,
  messages: readonly ConversationMessage[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(transcriptPath(dir, sessionName), JSON.stringify(messages, null, 2), "utf8");
}

export async function deleteTranscript(dir: string, sessionName: string): Promise<void> {
  await rm(transcriptPath(dir, sessionName), { force: true });
}

/**
 * Cap on transcripts retained per feature's `sessions/` directory. Transcripts
 * are deleted on a clean close (`closeNativeSession`) but kept when a turn
 * failed, so the kept-on-failure set otherwise grows without bound — nothing
 * else prunes it (issue #1445 is the same class of unbounded `~/.nax` growth).
 * Follows the precedent of `MAX_RETAINED_RUNS` in `src/metrics/tracker.ts`.
 */
export const MAX_RETAINED_TRANSCRIPTS = 50;

/**
 * One-shot dedupe flag, mirroring `hasWarnedAboutRunTruncation` in
 * `src/metrics/tracker.ts`: pruning runs on every failed close, so once a
 * feature is past the cap this would otherwise warn on every subsequent
 * close. Log it once per process lifetime instead.
 */
let hasWarnedAboutTranscriptTruncation = false;

/**
 * Reset the one-shot truncation-warning flag (for testing only).
 * @internal
 */
export function _resetTranscriptTruncationWarningForTests(): void {
  hasWarnedAboutTranscriptTruncation = false;
}

/**
 * Prune a feature's `sessions/` directory to the `maxRetained` most recently
 * modified transcript files, deleting the oldest first. Called from
 * `closeNativeSession`'s kept-on-failure branch — the only place transcripts
 * accumulate, since a clean close always deletes its own transcript.
 *
 * A missing directory is not an error (nothing to prune yet).
 */
export async function pruneRetainedTranscripts(
  dir: string,
  maxRetained: number = MAX_RETAINED_TRANSCRIPTS,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const transcriptFiles = entries.filter((name) => name.endsWith(".transcript.json"));
  if (transcriptFiles.length <= maxRetained) return;

  const withMtimes = await Promise.all(
    transcriptFiles.map(async (name) => {
      const fullPath = join(dir, name);
      const stats = await stat(fullPath);
      return { path: fullPath, mtimeMs: stats.mtimeMs };
    }),
  );
  // Oldest first, so the slice below drops exactly the excess over the cap.
  withMtimes.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toDelete = withMtimes.slice(0, withMtimes.length - maxRetained);
  await Promise.all(toDelete.map((f) => rm(f.path, { force: true })));

  if (!hasWarnedAboutTranscriptTruncation) {
    hasWarnedAboutTranscriptTruncation = true;
    getLogger().warn("native-session", "Transcript retention cap reached — oldest kept-on-failure transcripts pruned", {
      droppedCount: toDelete.length,
      maxRetained,
      dir,
    });
  }
}
