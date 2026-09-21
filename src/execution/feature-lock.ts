/**
 * Feature Lock — filesystem lock scoped to one feature under a project's
 * output directory (`<outputDir>/features/<feature>/nax.lock`).
 *
 * US-001 primitive: path, acquire, release, host lookup, and the two staleness
 * predicates, reusing the checkout lock's exclusive-create and stale-reclaim
 * guarantees (see ./lock.ts) and verifying ownership before release.
 *
 * The acquire path mirrors the checkout lock's rename→verify→restore dance
 * (BUG-34) so two worktrees racing on a stale lock cannot both believe they
 * hold it; release re-reads the lock and only unlinks when the on-disk runId
 * matches the caller's, so a release issued by a different run leaves a live
 * holder's lock untouched.
 */

import { mkdir, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { isProcessAlive } from "@/utils/process-alive";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { tryExclusiveCreate } from "./lock";

/** Two hours — the cross-host reclaim/suspect threshold. */
const STALE_AGE_MS = 2 * 3_600_000;

/**
 * Feature ID charset — mirrors `validateStoryId` (`src/prd/validate.ts`) and
 * the `featureDir` SEC-3 hardening in `src/config/paths/index.ts`. A leading
 * underscore is allowed so future sentinels (parallel to `_unattached`) keep
 * resolving. Path traversal (`..`) and a leading `--` (git-flag-shaped) are
 * rejected explicitly so the error names the actual problem instead of a
 * generic pattern mismatch.
 */
const FEATURE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/;

/**
 * SEC: reject feature values that would let `featureLockPath` escape the
 * intended `<outputDir>/features/<feature>/` subtree. Mirrors the SEC-3
 * guard in `src/config/paths/index.ts::featureDir` — that guard covers
 * writes under the feature tree from CLI entry points; this one covers the
 * feature lock's own reader/writer so a buggy or hostile caller can't make
 * the lock land outside the project (e.g. `featureLockPath(outDir, "../etc")`
 * would otherwise resolve to `<outDir>/features/../etc/nax.lock`).
 */
function validateFeatureId(featureId: string): void {
  if (!featureId || featureId.length === 0) {
    throw new NaxError("Feature ID cannot be empty", "INVALID_FEATURE_ID", { stage: "feature-lock" });
  }
  if (featureId.includes("..")) {
    throw new NaxError("Feature ID cannot contain path traversal (..)", "INVALID_FEATURE_ID", {
      stage: "feature-lock",
      featureId,
    });
  }
  if (featureId.startsWith("--")) {
    throw new NaxError("Feature ID cannot start with git flags (--)", "INVALID_FEATURE_ID", {
      stage: "feature-lock",
      featureId,
    });
  }
  if (!FEATURE_ID_PATTERN.test(featureId)) {
    throw new NaxError(
      `Feature ID must match pattern [a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}. Got: ${featureId}`,
      "INVALID_FEATURE_ID",
      { stage: "feature-lock", featureId },
    );
  }
}

export interface FeatureLockRecord {
  pid: number;
  host: string;
  workdir: string;
  feature: string;
  runId: string;
  startedAt: string;
  timestamp: number;
}

export type FeatureLockResult =
  | { acquired: true }
  | {
      acquired: false;
      holder: {
        pid: number;
        host: string;
        workdir: string;
        feature: string;
        runId: string;
        startedAt: string;
        timestamp: number;
      };
    };

/** Safely get logger instance, returns null if not initialized. */
function getSafeLogger() {
  try {
    return getLogger();
  } catch {
    return null;
  }
}

/**
 * Resolve the on-disk path to the feature lock file.
 * `<outputDir>/features/<feature>/nax.lock`
 *
 * Throws `NaxError("INVALID_FEATURE_ID")` when `feature` would let the
 * resolved path escape the intended subtree (path traversal, leading `--`,
 * empty, or characters outside the SEC-3 charset).
 */
export function featureLockPath(outputDir: string, feature: string): string {
  validateFeatureId(feature);
  return path.join(outputDir, "features", feature, "nax.lock");
}

/** Current machine hostname — used to classify a lock holder as local or foreign. */
export function lockHost(): string {
  return _featureLockDeps.host();
}

/**
 * Compute the age (ms) of a lock record at `now`. Prefers the `timestamp` field
 * (the canonical numeric clock) and falls back to parsing `startedAt` when the
 * record predates the timestamp field or it was stripped.
 */
function recordAgeMs(record: Partial<FeatureLockRecord>, now: number): number {
  if (typeof record.timestamp === "number") {
    return now - record.timestamp;
  }
  if (typeof record.startedAt === "string") {
    const startedAtMs = Date.parse(record.startedAt);
    if (Number.isFinite(startedAtMs)) {
      return now - startedAtMs;
    }
  }
  // No usable age signal — treat as infinitely old so foreign locks are reclaimable.
  return Number.POSITIVE_INFINITY;
}

/** True when `record.host` matches `localHost` (case-insensitive), or is absent. */
function isLocalHost(record: Partial<FeatureLockRecord>, localHost: string): boolean {
  if (typeof record.host !== "string" || record.host.length === 0) return true;
  return record.host.toLowerCase() === localHost.toLowerCase();
}

/**
 * Reclaimability verdict — "may acquire take this lock?".
 *
 * | host                  | Verdict                                              |
 * |:----------------------|:-----------------------------------------------------|
 * | local or absent       | reclaimable only when PID is not alive (any age)     |
 * | foreign               | reclaimable only at age >= STALE_AGE_MS              |
 */
export function isLockReclaimable(record: Partial<FeatureLockRecord> & { pid: number }, now: number): boolean {
  const local = isLocalHost(record, _featureLockDeps.host());
  if (local) {
    return !_featureLockDeps.isProcessAlive(record.pid);
  }
  return recordAgeMs(record, now) >= STALE_AGE_MS;
}

/**
 * Suspicion verdict — "is this lock suspiciously stale?".
 *
 * | host                  | Verdict                                              |
 * |:----------------------|:-----------------------------------------------------|
 * | local or absent       | suspect only when PID dead AND age >= STALE_AGE_MS   |
 * | foreign               | suspect at or beyond STALE_AGE_MS (PID ignored)      |
 */
export function isLockSuspect(record: Partial<FeatureLockRecord> & { pid: number }, now: number): boolean {
  const local = isLocalHost(record, _featureLockDeps.host());
  if (local) {
    return !_featureLockDeps.isProcessAlive(record.pid) && recordAgeMs(record, now) >= STALE_AGE_MS;
  }
  return recordAgeMs(record, now) >= STALE_AGE_MS;
}

/**
 * Build a refusal whose holder is read from `raw` (the on-disk JSON text).
 * Returns null when the content is missing or unparseable so the caller can
 * decide what to surface.
 */
function parseHolder(raw: string | null): FeatureLockRecord | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as FeatureLockRecord;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Empty holder used when the on-disk record is missing/corrupt at refusal time. */
function emptyHolder(feature: string): FeatureLockRecord {
  return {
    pid: 0,
    host: "",
    workdir: "",
    feature,
    runId: "",
    startedAt: "",
    timestamp: 0,
  };
}

/**
 * Acquire the feature lock. Creates `<outputDir>/features/<feature>/` when
 * missing. Mirrors the checkout lock's stale-reclaim flow: rename the existing
 * record to a tombstone, verify the tombstone's PID matches the stale PID we
 * observed (else restore), then exclusive-create the new record. The exclusive
 * create ensures a second caller arriving after we wrote it gets a refusal
 * rather than overwriting our record.
 */
export async function acquireFeatureLock(args: {
  outputDir: string;
  feature: string;
  workdir: string;
  runId: string;
}): Promise<FeatureLockResult> {
  const lockPath = _featureLockDeps.featureLockPath(args.outputDir, args.feature);
  const featureDir = path.dirname(lockPath);

  await mkdir(featureDir, { recursive: true });

  const lockFile = Bun.file(lockPath);
  if (await lockFile.exists()) {
    const existingContent = await lockFile.text();
    const existing = parseHolder(existingContent);

    if (existing === null) {
      // Corrupt / unparseable lock file — warn and treat as stale.
      const logger = getSafeLogger();
      logger?.warn("feature-lock", "Corrupt feature lock file detected, removing", {
        lockPath,
        feature: args.feature,
      });
      await _featureLockDeps.unlink(lockPath).catch(() => {});
    } else {
      const reclaimable = isLockReclaimable(existing, Date.now());
      if (!reclaimable) {
        return { acquired: false, holder: existing };
      }

      // Race-safe reclaim: rename the existing record to a tombstone so only
      // one racer can claim exclusive rights to clean it up. A second racer's
      // rename returns ENOENT and they back off.
      const tombstonePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
      try {
        await _featureLockDeps.rename(lockPath, tombstonePath);
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") {
          // Another racer won the rename race and the tombstone is already gone.
          // Re-read whoever currently holds the lock and report a refusal.
          const currentContent = await Bun.file(lockPath)
            .text()
            .catch(() => null);
          return {
            acquired: false,
            holder: parseHolder(currentContent) ?? emptyHolder(args.feature),
          };
        }
        throw renameErr;
      }

      // Verify the tombstone content still matches the stale PID we read. If
      // a third process slipped a fresh live lock in between our read and our
      // rename, restore it rather than destroying their lock.
      const tombstoneContent = await Bun.file(tombstonePath)
        .text()
        .catch(() => null);
      let tombstonePid: number | undefined;
      try {
        tombstonePid = tombstoneContent === null ? undefined : (JSON.parse(tombstoneContent) as { pid: number }).pid;
      } catch {
        tombstonePid = undefined;
      }

      if (tombstonePid !== existing.pid) {
        const restored =
          tombstoneContent !== null && (await _featureLockDeps.tryExclusiveCreate(lockPath, tombstoneContent));
        await _featureLockDeps.unlink(tombstonePath).catch(() => {});
        if (!restored) {
          const logger = getSafeLogger();
          logger?.warn("feature-lock", "Stolen feature lock could not be restored — a newer lock already exists", {
            lockPath,
            feature: args.feature,
          });
        }
        const currentContent = await Bun.file(lockPath)
          .text()
          .catch(() => null);
        return {
          acquired: false,
          holder: parseHolder(currentContent) ?? emptyHolder(args.feature),
        };
      }

      // Tombstone is ours — log and discard.
      const logger = getSafeLogger();
      logger?.warn("feature-lock", "Removing stale feature lock", {
        pid: existing.pid,
        feature: args.feature,
      });
      await _featureLockDeps.unlink(tombstonePath).catch(() => {});
    }
  }

  // Build the new record and exclusive-create it. If create fails (EEXIST) a
  // racer beat us to the punch — surface a refusal rather than overwriting.
  const record: FeatureLockRecord = {
    pid: process.pid,
    host: _featureLockDeps.host(),
    workdir: args.workdir,
    feature: args.feature,
    runId: args.runId,
    startedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };

  const created = await _featureLockDeps.tryExclusiveCreate(lockPath, JSON.stringify(record));
  if (!created) {
    const currentContent = await Bun.file(lockPath)
      .text()
      .catch(() => null);
    return {
      acquired: false,
      holder: parseHolder(currentContent) ?? emptyHolder(args.feature),
    };
  }

  return { acquired: true };
}

/**
 * Release the feature lock. Re-reads the on-disk record and only unlinks when
 * the holder's runId matches the caller's, so a release issued by a different
 * run leaves a live holder's lock untouched. ENOENT resolves silently; other
 * I/O errors (permissions, EIO, …) are warn-logged so a stale lock isn't
 * masked by a transient read failure.
 */
export async function releaseFeatureLock(args: { outputDir: string; feature: string; runId: string }): Promise<void> {
  const lockPath = _featureLockDeps.featureLockPath(args.outputDir, args.feature);
  const lockFile = Bun.file(lockPath);

  let content: string | null;
  try {
    content = await lockFile.text();
  } catch (readErr) {
    const code = (readErr as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    const logger = getSafeLogger();
    logger?.warn("feature-lock", "Failed to read feature lock for release", {
      error: (readErr as Error).message,
      code,
      lockPath,
      feature: args.feature,
    });
    return;
  }

  const holder = parseHolder(content);
  if (holder === null) return;
  if (holder.runId !== args.runId) return;

  const tombstonePath = `${lockPath}.release.${process.pid}.${Date.now()}`;
  try {
    await _featureLockDeps.rename(lockPath, tombstonePath);
  } catch (renameErr) {
    const code = (renameErr as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      getSafeLogger()?.warn("feature-lock", "Failed to claim feature lock for release", {
        error: (renameErr as Error).message,
        lockPath,
        feature: args.feature,
      });
    }
    return;
  }

  const tombstoneContent = await Bun.file(tombstonePath)
    .text()
    .catch(() => null);
  const tombstoneHolder = parseHolder(tombstoneContent);
  if (tombstoneHolder?.runId !== args.runId && tombstoneContent !== null) {
    await _featureLockDeps.tryExclusiveCreate(lockPath, tombstoneContent);
  }
  await _featureLockDeps.unlink(tombstonePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") {
      getSafeLogger()?.warn("feature-lock", "Failed to discard released feature lock", {
        error: err.message,
        lockPath: tombstonePath,
        feature: args.feature,
      });
    }
  });
}

/**
 * Test seam — mirrors `_lockDeps` in ./lock.ts so the rename race and PID
 * liveness can be controlled deterministically. Production code never reads
 * this; tests assign individual fields then restore them.
 */
export const _featureLockDeps = {
  featureLockPath: featureLockPath as typeof featureLockPath,
  host: (): string => hostname(),
  isProcessAlive: isProcessAlive as typeof isProcessAlive,
  rename: rename as typeof rename,
  tryExclusiveCreate: tryExclusiveCreate as typeof tryExclusiveCreate,
  unlink: unlink as typeof unlink,
};
