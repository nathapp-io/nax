/**
 * Session Scratch Writer
 *
 * Appends structured observations to a session's scratch.jsonl log.
 * Pipeline stages (verify, rectify) call this to record their outcomes;
 * the SessionScratchProvider reads these entries to surface them as
 * context chunks in later stages.
 *
 * Storage: <scratchDir>/scratch.jsonl
 * Format: one JSON object per line (JSONL / newline-delimited JSON)
 *
 * Phase 1: write-only from verify and rectify.
 * Phase 2+: additional stages (review, autofix) contribute entries.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Session model
 */

// node:fs/promises exception: Bun has no native atomic-append or recursive-mkdir
// equivalent. appendFile uses O_APPEND (atomic for concurrent writers); mkdir
// uses { recursive: true } to avoid EEXIST races. Both are safe cross-platform.
import { appendFile as fsAppendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Entry types
// ─────────────────────────────────────────────────────────────────────────────

/** Entry written after a verify stage run */
export interface VerifyScratchEntry {
  kind: "verify-result";
  timestamp: string;
  storyId: string;
  stage: string;
  success: boolean;
  /** Verify status code */
  status: string;
  passCount: number;
  failCount: number;
  /** Last 500 chars of raw test output — enough for a rectifier to see what failed */
  rawOutputTail: string;
  /** Agent id that produced this entry. For cross-agent scratch neutralization (AC-42). */
  writtenByAgent?: string;
}

/** Entry written after each rectification attempt */
export interface RectifyScratchEntry {
  kind: "rectify-attempt";
  timestamp: string;
  storyId: string;
  stage: string;
  attempt: number;
  succeeded: boolean;
  /** Agent id that produced this entry. For cross-agent scratch neutralization (AC-42). */
  writtenByAgent?: string;
}

/** Entry written after each TDD sub-session to carry discoveries forward */
export interface TddSessionScratchEntry {
  kind: "tdd-session";
  timestamp: string;
  storyId: string;
  stage: string;
  role: "test-writer" | "implementer" | "verifier";
  success: boolean;
  filesChanged: string[];
  /** Tail of agent output for lightweight cross-session continuity */
  outputTail: string;
  /** Agent id that produced this entry. For cross-agent scratch neutralization (AC-42). */
  writtenByAgent?: string;
}

export type ScratchEntry = VerifyScratchEntry | RectifyScratchEntry | TddSessionScratchEntry;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _scratchWriterDeps = {
  now: (): string => new Date().toISOString(),
  /** Read existing file content; resolves to empty string if file absent */
  readFile: async (path: string): Promise<string> => {
    const f = Bun.file(path);
    return (await f.exists()) ? f.text() : Promise.resolve("");
  },
  /** Write (overwrite) the file at path */
  writeFile: (path: string, content: string): Promise<number> => Bun.write(path, content),
  /** Append content to the file at path (atomic append — avoids read-modify-write race) */
  appendFile: (path: string, content: string): Promise<void> => fsAppendFile(path, content, "utf8"),
  /** Create directory and parents */
  mkdirp: (path: string): Promise<string | undefined> => mkdir(path, { recursive: true }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Scratch path
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves the JSONL scratch file path from the scratch directory */
export function scratchFilePath(scratchDir: string): string {
  return `${scratchDir}/scratch.jsonl`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Append
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a single entry to <scratchDir>/scratch.jsonl.
 *
 * Creates the directory and file if they do not exist.
 * Reads existing content and appends a new JSONL line — safe for Phase 1
 * where writes are sequential (one stage at a time).
 *
 * Callers should wrap in try-catch: scratch writes are best-effort and
 * must never block stage execution.
 *
 * @param scratchDir - Absolute path to the session scratch directory
 * @param entry      - Structured observation to record
 */
/** Cap on per-entry output-tail payload written to disk (chars). */
const SCRATCH_OUTPUT_TAIL_MAX_CHARS = 2048;

function truncateOutputFields(entry: ScratchEntry): ScratchEntry {
  if (entry.kind === "verify-result" && entry.rawOutputTail.length > SCRATCH_OUTPUT_TAIL_MAX_CHARS) {
    return { ...entry, rawOutputTail: entry.rawOutputTail.slice(-SCRATCH_OUTPUT_TAIL_MAX_CHARS) };
  }
  if (entry.kind === "tdd-session" && entry.outputTail.length > SCRATCH_OUTPUT_TAIL_MAX_CHARS) {
    return { ...entry, outputTail: entry.outputTail.slice(-SCRATCH_OUTPUT_TAIL_MAX_CHARS) };
  }
  return entry;
}

export async function appendScratchEntry(scratchDir: string, entry: ScratchEntry): Promise<void> {
  const filePath = scratchFilePath(scratchDir);
  await _scratchWriterDeps.mkdirp(dirname(filePath));
  const line = JSON.stringify(truncateOutputFields(entry));
  await _scratchWriterDeps.appendFile(filePath, `${line}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Digest files
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves the digest file path: <scratchDir>/digest-<stageKey>.txt */
export function digestFilePath(scratchDir: string, stageKey: string): string {
  return `${scratchDir}/digest-${stageKey}.txt`;
}

/**
 * Write a stage digest to <scratchDir>/digest-<stageKey>.txt.
 *
 * Overwrites any existing digest for this stage key — only the latest
 * digest is kept per stage.
 *
 * Callers should wrap in try-catch: digest writes are best-effort and
 * must never block stage execution.
 *
 * @param scratchDir - Absolute path to the session scratch directory
 * @param stageKey   - Stage identifier (e.g. "context", "verify")
 * @param digest     - Terse summary produced by buildDigest()
 */
export async function writeDigestFile(scratchDir: string, stageKey: string, digest: string): Promise<void> {
  const filePath = digestFilePath(scratchDir, stageKey);
  await _scratchWriterDeps.mkdirp(dirname(filePath));
  await _scratchWriterDeps.writeFile(filePath, digest);
}

/**
 * Read a stage digest from <scratchDir>/digest-<stageKey>.txt.
 *
 * Returns the trimmed digest string, or "" if the file does not exist.
 *
 * Callers should wrap in try-catch to handle unexpected I/O errors.
 *
 * @param scratchDir - Absolute path to the session scratch directory
 * @param stageKey   - Stage identifier (e.g. "context", "verify")
 */
export async function readDigestFile(scratchDir: string, stageKey: string): Promise<string> {
  const content = await _scratchWriterDeps.readFile(digestFilePath(scratchDir, stageKey));
  return content.trim();
}
