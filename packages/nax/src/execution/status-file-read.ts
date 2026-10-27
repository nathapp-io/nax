/** Fail-soft status.json reader shared by CLI and workflow tooling. */
import { join } from "node:path";
import type { NaxStatusFile } from "./status-file";

/** Injectable file access for status reads. */
export const _statusFileReadDeps = {
  file: Bun.file,
};

/** Read an arbitrary status file; missing, malformed and drifted files have no status. */
export async function readStatusFileAt(path: string): Promise<NaxStatusFile | null> {
  try {
    const raw: unknown = await _statusFileReadDeps.file(path).json();
    return isUsableStatusFile(raw) ? raw : null;
  } catch {
    // Status artifacts are best-effort diagnostics, including unreadable or torn writes.
    return null;
  }
}

/** Read the status.json belonging to a feature directory. */
export function readStatusFile(featureDir: string): Promise<NaxStatusFile | null> {
  return readStatusFileAt(join(featureDir, "status.json"));
}

/**
 * BUG-16: minimal shape guard for a read status.json. Rejects files that
 * parsed as JSON but drifted from the schema (older format, torn write) —
 * the display functions below dereference `run.pid`, `cost.spent` and
 * `progress.passed` unconditionally, and `postRun.acceptance/regression`
 * when `postRun` is present.
 */
function isUsableStatusFile(value: unknown): value is NaxStatusFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;

  const run = v.run as Record<string, unknown> | undefined;
  if (!run || typeof run.id !== "string" || typeof run.status !== "string" || typeof run.pid !== "number") {
    return false;
  }
  const cost = v.cost as Record<string, unknown> | undefined;
  if (!cost || typeof cost.spent !== "number") return false;
  // BUG-16 (review): the cost-limit banner does `(cost.limit ?? 0).toFixed(4)`
  // — a non-number `limit` crashes it just like a missing section would.
  if (typeof cost.limit !== "number" && cost.limit !== null) return false;
  const progress = v.progress as Record<string, unknown> | undefined;
  if (!progress || typeof progress.passed !== "number" || typeof progress.total !== "number") return false;

  const postRun = v.postRun as Record<string, unknown> | undefined;
  if (postRun !== undefined) {
    const acceptance = postRun.acceptance as Record<string, unknown> | undefined;
    const regression = postRun.regression as Record<string, unknown> | undefined;
    if (!acceptance || typeof acceptance.status !== "string") return false;
    if (!regression || typeof regression.status !== "string") return false;
  }
  return true;
}
