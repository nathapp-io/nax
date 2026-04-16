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

import { mkdir } from "node:fs/promises";
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
}

/** Entry written after each rectification attempt */
export interface RectifyScratchEntry {
  kind: "rectify-attempt";
  timestamp: string;
  storyId: string;
  stage: string;
  attempt: number;
  succeeded: boolean;
}

export type ScratchEntry = VerifyScratchEntry | RectifyScratchEntry;

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
export async function appendScratchEntry(scratchDir: string, entry: ScratchEntry): Promise<void> {
  const filePath = scratchFilePath(scratchDir);
  await _scratchWriterDeps.mkdirp(dirname(filePath));
  const existing = await _scratchWriterDeps.readFile(filePath);
  const line = JSON.stringify(entry);
  await _scratchWriterDeps.writeFile(filePath, existing ? `${existing}${line}\n` : `${line}\n`);
}
