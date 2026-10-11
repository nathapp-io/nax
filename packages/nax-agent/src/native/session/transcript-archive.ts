/**
 * Audit archive for native session transcripts (nax#2453).
 *
 * `closeNativeSession` deletes a clean session's transcript and renames a failed
 * one, so a passing session, which is where most tokens go, left no turn-level
 * record. When the caller opts in, this writes a redacted copy into an archive
 * directory first. The archive file name contains `.transcript.` and ends in
 * `.json`, so `pruneRetainedTranscripts` already counts it; it never sits in the
 * live `sessions/` directory, so it can never be loaded as a resumption source
 * (nax#1877).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "#src/infra/index";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { redactSecrets } from "#src/internal/redact";
import { pruneRetainedTranscripts } from "./transcript-store.ts";
import type { TranscriptStore } from "./transcript-types.ts";

/** Where, and how many, archived transcripts are kept (the `OpenSessionOpts.transcriptArchive` shape). */
export interface TranscriptArchive {
  readonly dir: string;
  readonly maxRetained: number;
}

/**
 * Write a redacted copy of the session's transcript into `archive.dir`, then
 * prune the directory to `archive.maxRetained`. Nothing to archive (no saved
 * document) is a quiet return. Every error is logged and swallowed: the archive
 * is supplementary and must never change how a session closes.
 */
export async function archiveTranscript(
  store: TranscriptStore,
  sessionId: string,
  archive: TranscriptArchive,
): Promise<void> {
  try {
    const doc = await store.load(sessionId);
    if (doc === null) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await mkdir(archive.dir, { recursive: true });
    await writeFileAtomic(
      join(archive.dir, `${sessionId}.transcript.${stamp}.json`),
      JSON.stringify(redactSecrets(doc), null, 2),
    );
    await pruneRetainedTranscripts(archive.dir, archive.maxRetained);
  } catch (err) {
    getLogger().warn("native-session", "Transcript archive failed; close continues unchanged", {
      sessionId,
      dir: archive.dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
