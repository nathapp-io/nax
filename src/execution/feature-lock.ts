/**
 * Feature Lock — filesystem lock scoped to one feature under a project's
 * output directory (`<outputDir>/features/<feature>/nax.lock`).
 *
 * US-001 primitive: path, acquire, release, host lookup, and the two staleness
 * predicates, reusing the checkout lock's exclusive-create and stale-reclaim
 * guarantees (see ./lock.ts) and verifying ownership before release.
 *
 * NOTE (stub): this file currently only carries the exported surface so the
 * acceptance tests in test/unit/execution/feature-lock.test.ts compile. The
 * `_featureLockDeps` seam extends the story's minimal sketch with `host`,
 * `isProcessAlive`, `rename`, `tryExclusiveCreate` and `unlink` — mirroring
 * `_lockDeps` in ./lock.ts — because AC3/AC5–AC11/AC17 require deterministic
 * control of hostname, PID-liveness and the rename race in tests.
 */

import { rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { isProcessAlive } from "@/utils/process-alive";
import { tryExclusiveCreate } from "./lock";

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

// Stub: real implementation returns <outputDir>/features/<feature>/nax.lock
export function featureLockPath(outputDir: string, feature: string): string {
  return path.join(outputDir, "features", feature, "stub.lock");
}

// Stub: real implementation returns os.hostname()
export function lockHost(): string {
  return "stub-host";
}

// Stub: real implementation writes a FeatureLockRecord via tryExclusiveCreate
export async function acquireFeatureLock(_args: {
  outputDir: string;
  feature: string;
  workdir: string;
  runId: string;
}): Promise<FeatureLockResult> {
  return { acquired: true };
}

// Stub: real implementation unlinks only when the on-disk runId equals the caller's
export async function releaseFeatureLock(_args: { outputDir: string; feature: string; runId: string }): Promise<void> {
  /* stub: no-op until implemented */
}

// Stub: real implementation implements the reclaimability table
export function isLockReclaimable(_record: Partial<FeatureLockRecord> & { pid: number }, _now: number): boolean {
  return false;
}

// Stub: real implementation implements the suspicion table
export function isLockSuspect(_record: Partial<FeatureLockRecord> & { pid: number }, _now: number): boolean {
  return false;
}

export const _featureLockDeps = {
  featureLockPath: featureLockPath as typeof featureLockPath,
  host: (): string => hostname(),
  isProcessAlive: isProcessAlive as typeof isProcessAlive,
  rename: rename as typeof rename,
  tryExclusiveCreate: tryExclusiveCreate as typeof tryExclusiveCreate,
  unlink: unlink as typeof unlink,
};
