/**
 * Conversation persistence for the native transport.
 *
 * nax-ai's client is stateless — every call takes the whole message array — so
 * nax keeps the conversation. Under ACP the acpx subprocess remembered it and
 * nax stored nothing; SessionDescriptor still has no message field, and gains
 * none. See ADR-028 sections 2 and 3.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";

export function transcriptPath(dir: string, sessionName: string): string {
  return join(dir, `${sessionName}.transcript.json`);
}

/**
 * On-disk shape. Wrapping the messages rather than storing a bare array is what
 * makes nax#1877 unrepresentable: the file records WHO it belongs to, so the
 * next session of the same (deterministic) name can tell "my own history" from
 * "an abandoned invocation's history" instead of resuming whatever is there.
 *
 * `owner` is the op invocation's `scopeId ?? callId` — stable across the retries
 * and hops of one invocation, different for every new stage entry, run and
 * process. Keying on it preserves nax#1838's retry continuity, which is a
 * within-invocation requirement, while denying cross-invocation inheritance.
 */
interface TranscriptFile {
  readonly owner?: string;
  readonly savedAt: string;
  readonly messages: ConversationMessage[];
}

/** A bare array is a pre-#1877 transcript: real messages, no recorded owner. */
function isLegacyTranscript(parsed: unknown): parsed is ConversationMessage[] {
  return Array.isArray(parsed);
}

/**
 * Missing file means a new conversation. Anything else is a real failure.
 *
 * Returns `[]` — a new conversation — when the transcript on disk belongs to a
 * different `owner` than the caller (nax#1877). A reader that declares no owner
 * is not making an ownership claim and reads whatever is there, which keeps
 * non-op callers and unit tests working unchanged.
 */
export async function loadTranscript(dir: string, sessionName: string, owner?: string): Promise<ConversationMessage[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(dir, sessionName), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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

  if (isLegacyTranscript(parsed)) {
    // Unowned history is foreign history to a reader that has an identity.
    // Dropping it is the safe direction: the cost is one re-exploration, where
    // inheriting it silently bills a conversation this session never had.
    return owner === undefined ? parsed : [];
  }

  const file = parsed as TranscriptFile;
  if (owner !== undefined && file.owner !== owner) {
    getLogger().debug("native-session", "Ignoring a transcript owned by another invocation", {
      sessionName,
      storedOwner: file.owner,
      owner,
    });
    return [];
  }
  return file.messages ?? [];
}

export async function saveTranscript(
  dir: string,
  sessionName: string,
  messages: readonly ConversationMessage[],
  owner?: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file: TranscriptFile = {
    ...(owner !== undefined ? { owner } : {}),
    savedAt: new Date().toISOString(),
    messages: [...messages],
  };
  await writeFile(transcriptPath(dir, sessionName), JSON.stringify(file, null, 2), "utf8");
}

/**
 * Move a failed session's transcript off the path the next session reads.
 *
 * The kept-on-failure transcript (nax#1838) used to stay at its live name, which
 * is exactly the name `loadTranscript` opens — so the post-mortem artifact and
 * the resumption source were one file (nax#1877). Renaming keeps every byte of
 * debugging value and removes the resumption entirely. It also stops the NEXT
 * attempt's `saveTranscript` from overwriting the artifact #1838 wanted kept.
 *
 * A missing transcript is not an error: a session can fail before its first save.
 */
export async function retainTranscript(dir: string, sessionName: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await rename(transcriptPath(dir, sessionName), join(dir, `${sessionName}.transcript.failed-${stamp}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
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
 *
 * Returns the number of transcript files deleted (0 when there is nothing to
 * delete) so callers can report the sweep's work without re-reading the dir.
 */
export async function pruneRetainedTranscripts(
  dir: string,
  maxRetained: number = MAX_RETAINED_TRANSCRIPTS,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  // Matches both the live name and the `failed-<stamp>` names `retainTranscript`
  // produces — the retained set is the one that accumulates, so a filter that
  // missed it would leave the cap enforcing nothing.
  const transcriptFiles = entries.filter((name) => name.includes(".transcript.") && name.endsWith(".json"));
  if (transcriptFiles.length <= maxRetained) return 0;

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
  return toDelete.length;
}
