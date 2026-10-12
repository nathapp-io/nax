/**
 * Finish A §4.4: the serialized FinishState after every completed step, for
 * `nax finish --resume` (sub-project E); nothing reads it in A. Atomic (a unique
 * temp file in the same directory, then rename), so no partial checkpoint is ever
 * visible at the final path. Best-effort: a write failure is logged and never
 * stops finish.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import type { AuditTarget } from "./audit";
import { type FinishState, serializeFinishState } from "./state";

export const _checkpointDeps = {
  mkdir: async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true });
  },
  writeFile: (path: string, text: string): Promise<void> => writeFile(path, text, "utf8"),
  rename: (from: string, to: string): Promise<void> => rename(from, to),
  remove: (path: string): Promise<void> => rm(path, { force: true }),
  uniqueId: (): string => crypto.randomUUID(),
};

export function checkpointPath(audit: AuditTarget): string {
  return join(audit.auditDir, `${audit.runId}.checkpoint.json`);
}

export async function writeCheckpoint(audit: AuditTarget, state: FinishState): Promise<void> {
  const target = checkpointPath(audit);
  const tmp = join(audit.auditDir, `${audit.runId}.checkpoint.${_checkpointDeps.uniqueId()}.tmp`);
  try {
    // Serialized before any await: the loops keep mutating `state` while the write is in flight.
    const text = serializeFinishState(state);
    await _checkpointDeps.mkdir(audit.auditDir);
    await _checkpointDeps.writeFile(tmp, text);
    await _checkpointDeps.rename(tmp, target);
  } catch (err) {
    await _checkpointDeps.remove(tmp).catch(() => undefined);
    getSafeLogger()?.warn("finish", "Finish checkpoint could not be written", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
}
