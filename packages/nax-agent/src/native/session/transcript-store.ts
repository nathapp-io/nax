/**
 * Conversation persistence for the native transport.
 *
 * nax-ai's client is stateless — every call takes the whole message array — so
 * nax keeps the conversation. Under ACP the acpx subprocess remembered it and
 * nax stored nothing; SessionDescriptor still has no message field, and gains
 * none. See ADR-028 sections 2 and 3.
 */

import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { getLogger, NaxError } from "#src/infra/index";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { historyFromTranscript, type TranscriptIdentity, transcriptDocFor } from "./transcript-identity.ts";
import {
  assertStoredImageLists,
  assertSupportedSchema,
  rehydrateTranscriptImages,
  splitTranscriptImages,
  transcriptImagesPath,
} from "./transcript-images.ts";

import type { TranscriptDoc, TranscriptStore, TurnMarker } from "./transcript-types.ts";

/** Folder lifecycle seam; the JSON operations retain their existing behavior. */
export const _transcriptLifecycleDeps = { rename, rm };

export { type TranscriptIdentity, transcriptModelIdentity } from "./transcript-identity.ts";

export function transcriptPath(dir: string, sessionName: string): string {
  return join(dir, `${sessionName}.transcript.json`);
}

/** `savedAt` for a pre-#1877 bare-array transcript, which recorded none. */
const LEGACY_SAVED_AT = new Date(0).toISOString();

function corruptTranscript(sessionName: string, reason: string): NaxError {
  return new NaxError(`transcript for session "${sessionName}" is unreadable: ${reason}`, "TRANSCRIPT_CORRUPT", {
    stage: "native-session",
  });
}

/**
 * The stored bytes, parsed. `undefined` — never a JSON value — means "no file", so a body
 * of `null` still reads as the corrupt document it is.
 */
async function readStoredJson(dir: string, sessionName: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(dir, sessionName), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Deliberately not null: silently restarting a conversation would drop the
    // history the model is mid-way through and look like a fresh session.
    throw corruptTranscript(sessionName, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Missing file means no document. Anything else unreadable is a real failure.
 *
 * The file wraps the messages rather than storing a bare array, which is what
 * makes nax#1877 unrepresentable: it records WHO it belongs to (`owner`, the op
 * invocation's `scopeId ?? callId`) and which model wrote it (`model`, nax#2150),
 * so the next session of the same deterministic name can tell its own history
 * from an abandoned invocation's or another model's. A bare array is a pre-#1877
 * transcript: it loads as an owner-less document, which `historyFromTranscript`
 * then drops for any reader that has an owner.
 */
export async function readTranscriptDoc(dir: string, sessionName: string): Promise<TranscriptDoc | null> {
  const parsed = await readStoredJson(dir, sessionName);
  if (parsed === undefined) return null;
  if (Array.isArray(parsed)) return { savedAt: LEGACY_SAVED_AT, messages: parsed as ConversationMessage[] };
  if (typeof parsed !== "object" || parsed === null) throw corruptTranscript(sessionName, "not a transcript document");
  const doc = await rehydrateTranscriptImages(transcriptPath(dir, sessionName), parsed);
  return { ...doc, messages: doc.messages ?? [] };
}

/** Publish a document exactly as given; splitting images is the caller's decision. */
async function writeStoredDocument(dir: string, sessionName: string, doc: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(transcriptPath(dir, sessionName), JSON.stringify(doc, null, 2), { mode: 0o600 });
}

async function writeTranscriptDoc(dir: string, sessionName: string, doc: TranscriptDoc): Promise<void> {
  const stored = await splitTranscriptImages(transcriptPath(dir, sessionName), doc);
  // Publish JSON only after all image files have been published successfully.
  await writeStoredDocument(dir, sessionName, stored);
}

/**
 * The document a marker write starts from: the stored JSON, validated but never hydrated.
 *
 * Hydrating here would defeat the point of a marker write (review finding 10): an image
 * that is temporarily absent would come back as a persisted `[image missing]` note with
 * its ref dropped, and every sidecar would be re-published for a write that changes one
 * field. So the format checks run on the parsed JSON and touch no file, and the document's
 * own fields — `owner`, `model`, `savedAt`, `schemaVersion`, the stored refs with their
 * metadata — are republished exactly as they stand.
 */
function markerDocument(sessionName: string, stored: unknown): Record<string, unknown> {
  if (stored === undefined) return { savedAt: new Date().toISOString(), messages: [] };
  // A pre-#1877 bare array: wrap it, and do not migrate its inline images to sidecars.
  if (Array.isArray(stored)) return { savedAt: LEGACY_SAVED_AT, messages: stored };
  if (typeof stored !== "object" || stored === null) {
    throw corruptTranscript(sessionName, "not a transcript document");
  }
  const doc = stored as Record<string, unknown>;
  assertSupportedSchema(doc);
  const messages = doc.messages === undefined ? [] : doc.messages;
  // A v2 container that is not a list is unreadable: reject before publishing anything.
  if (!Array.isArray(messages)) throw corruptTranscript(sessionName, "messages is not an array");
  assertStoredImageLists(doc.schemaVersion, messages);
  return { ...doc, messages };
}

/**
 * The file store: `<dir>/<name>.transcript.json`, written as given (the loop's
 * documents carry no schemaVersion or turn, so nax's bytes are unchanged).
 * `retainFailed` is the kept-on-failure rename plus an archives-only prune to
 * `MAX_RETAINED_TRANSCRIPTS`, so it bounds only the archives it keeps — a live
 * document is some other chat's resumption source and is never evicted by a
 * failure (review e684). Live names are bounded by the feature-startup sweep
 * (`sweepFeatureTranscripts`), which prunes both kinds together.
 */
export function createFileTranscriptStore(dir: string): TranscriptStore {
  return {
    load: (sessionId) => readTranscriptDoc(dir, sessionId),
    save: (sessionId, doc) => writeTranscriptDoc(dir, sessionId, doc),
    retainFailed: async (sessionId) => {
      await retainTranscript(dir, sessionId);
      await pruneRetainedTranscripts(dir, MAX_RETAINED_TRANSCRIPTS, { archivesOnly: true });
    },
    delete: (sessionId) => deleteTranscript(dir, sessionId),
    markTurn: async (sessionId: string, marker: TurnMarker) => {
      // A metadata-only update: read the stored JSON, publish it with `turn` replaced.
      // Hydrating here would rewrite image refs from sidecars (review finding 10).
      // Read afresh on every call — `running` and `ended` straddle the turn's save, so a
      // snapshot cached from the start of the turn would publish the pre-turn document back.
      const base = markerDocument(sessionId, await readStoredJson(dir, sessionId));
      await writeStoredDocument(dir, sessionId, { ...base, turn: marker });
    },
  };
}

/**
 * File-level convenience over the file store: the history `sessionName` may
 * resume from `dir`. `[]` — a new conversation — when there is no file or it
 * belongs to a different `owner` or recorded `model` (nax#1877, nax#2150).
 */
export async function loadTranscript(
  dir: string,
  sessionName: string,
  identity: TranscriptIdentity = {},
): Promise<ConversationMessage[]> {
  return [...historyFromTranscript(await readTranscriptDoc(dir, sessionName), identity, sessionName)];
}

/** File-level convenience over the file store: save a loop document. */
export async function saveTranscript(
  dir: string,
  sessionName: string,
  messages: readonly ConversationMessage[],
  identity: TranscriptIdentity = {},
): Promise<void> {
  await writeTranscriptDoc(dir, sessionName, transcriptDocFor(messages, identity));
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
  const live = transcriptPath(dir, sessionName);
  const retained = join(dir, `${sessionName}.transcript.failed-${stamp}.json`);
  try {
    await rename(live, retained);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    await _transcriptLifecycleDeps.rename(transcriptImagesPath(live), transcriptImagesPath(retained));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    // Restore the live JSON on failure so its still-live sidecar remains loadable
    // and a later retention attempt can move the pair again.
    try {
      await _transcriptLifecycleDeps.rename(retained, live);
    } catch (rollbackError) {
      throw new NaxError("Transcript retention rollback failed", "TRANSCRIPT_RETENTION_ROLLBACK_FAILED", {
        stage: "native-session",
        cause: err,
        rollbackError,
        live,
        retained,
      });
    }
    throw err;
  }
}

async function deleteTranscriptFile(path: string): Promise<void> {
  await rm(path, { force: true });
  await _transcriptLifecycleDeps.rm(transcriptImagesPath(path), { recursive: true, force: true });
}

export async function deleteTranscript(dir: string, sessionName: string): Promise<void> {
  await deleteTranscriptFile(transcriptPath(dir, sessionName));
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
 * Marker `retainTranscript` puts in a kept-on-failure archive's name:
 * `<name>.transcript.failed-<stamp>.json`.
 */
const RETAINED_ARCHIVE_MARKER = ".transcript.failed-";

/**
 * Whether one directory entry counts against the retention cap.
 *
 * Both kinds of transcript end in `.json` and carry `.transcript.`, so the
 * marker is what tells a kept-on-failure archive from a live document. The
 * `archivesOnly` arm deliberately excludes live names: a live document is
 * resumable, an archive is not.
 */
function countsTowardsRetention(name: string, archivesOnly: boolean): boolean {
  if (!name.endsWith(".json")) return false;
  return archivesOnly ? name.includes(RETAINED_ARCHIVE_MARKER) : name.includes(".transcript.");
}

/**
 * Prune a directory down to the `maxRetained` most recently modified transcript
 * files, deleting the oldest first.
 *
 * By default live documents and kept-on-failure archives are counted together,
 * which is what the feature-startup sweep needs: nothing else bounds the live
 * names sitting in a feature's `sessions/` directory. A failed close passes
 * `{ archivesOnly: true }`, which counts and deletes only the
 * `<name>.transcript.failed-<stamp>.json` archives `retainTranscript` produces —
 * a live document is the resumption source for a chat that has NOT failed, so
 * evicting one on another chat's failure silently restarted that chat
 * (review e684). Live names are bounded by the feature-startup sweep instead.
 *
 * A missing directory is not an error (nothing to prune yet).
 *
 * Returns the number of transcript files deleted (0 when there is nothing to
 * delete) so callers can report the sweep's work without re-reading the dir.
 */
export async function pruneRetainedTranscripts(
  dir: string,
  maxRetained: number = MAX_RETAINED_TRANSCRIPTS,
  opts?: { readonly archivesOnly?: boolean },
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  const transcriptFiles = entries.filter((name) => countsTowardsRetention(name, opts?.archivesOnly === true));
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
  await Promise.all(toDelete.map((f) => deleteTranscriptFile(f.path)));

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
