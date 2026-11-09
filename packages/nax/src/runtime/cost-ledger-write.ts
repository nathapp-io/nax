/**
 * Atomic cost-ledger writes (US-004).
 *
 * `CostAggregator.drain()` rewrites `<runId>.jsonl` whole on every pass, and that
 * file is the audit trail `nax cost` reads. An in-place write is not safe there:
 * a process that dies mid-write, or a short write on a full disk, leaves a
 * truncated ledger that no later drain can repair — the next drain starts from
 * the scan of an already-broken file. Writing a sibling temp file and renaming it
 * over the ledger makes the swap atomic within the directory, so a reader sees
 * either the previous file or the new one, never a half-written one.
 */
import { rename, unlink } from "node:fs/promises";

/** Distinguishes concurrent writers' temp files without a clock read or randomness. */
let tempCounter = 0;

/**
 * `<path>.tmp-<pid>-<counter>`.
 *
 * The pid separates processes, the counter separates passes within one process.
 * The name deliberately does not end in `.jsonl`, so the `cost/*.jsonl` glob
 * (`cli/cost-ledger-query.ts`) can never pick up a half-written sibling.
 */
function nextTempPath(path: string): string {
  tempCounter += 1;
  return `${path}.tmp-${process.pid}-${tempCounter}`;
}

/**
 * Write `data` to `path` through a sibling temp file, resolving to the bytes written.
 *
 * On any failure the temp file is removed (best effort) and the error rethrown, so
 * the ledger keeps its previous contents and a crashed write leaves at most one
 * temp sibling behind — which nothing globs and no reader parses.
 */
export async function writeLedgerAtomic(path: string, data: string): Promise<number> {
  const tempPath = nextTempPath(path);
  try {
    const written = await Bun.write(tempPath, data);
    await rename(tempPath, path);
    return written;
  } catch (err) {
    // Best effort only: the temp file is inert (nothing reads it), so a failed
    // unlink must not mask the error that actually stopped the write.
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}
