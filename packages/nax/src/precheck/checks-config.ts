/**
 * Configuration-related precheck implementations
 */

import { existsSync, statSync } from "node:fs";
import { type FeatureLockRecord, featureLockPath, isLockSuspect } from "@/execution";
import { isProcessAlive } from "@/utils/process-alive";
import type { PRD } from "../prd/types";
import type { Check } from "./types";

/** A feature-scoped lock argument for `checkStaleLock`. */
export interface FeatureLockRef {
  /** Resolved project output directory (typically `<projectKey>` or an override). */
  outputDir: string;
  /** Feature name, used to compute `<outputDir>/features/<feature>/nax.lock`. */
  feature: string;
}

/**
 * Read and parse the checkout lock at `<workdir>/nax.lock`. Returns null when
 * the file is absent, unreadable, or unparseable so the caller can fall back
 * to a default verdict.
 *
 * US-003: the parsed record also carries `host` (when present) so the
 * caller can apply `isLockSuspect`'s foreign-vs-local split to the checkout
 * lock too — a foreign-host checkout lock is suspect at age >= STALE_AGE_MS
 * regardless of whether the PID happens to be alive locally (PID-recycling
 * case). Older checkout locks that omit `host` are treated as local by
 * `isLockSuspect`, preserving the historical verdict.
 */
async function readCheckoutRecord(
  workdir: string,
): Promise<{ pid: number; timestamp?: number; startedAt?: string; host?: string } | null> {
  const lockPath = `${workdir}/nax.lock`;
  if (!existsSync(lockPath)) return null;
  try {
    const content = await Bun.file(lockPath).text();
    const parsed = JSON.parse(content) as {
      pid?: unknown;
      timestamp?: unknown;
      startedAt?: unknown;
      host?: unknown;
    };
    if (typeof parsed.pid !== "number") return null;
    const record: { pid: number; timestamp?: number; startedAt?: string; host?: string } = {
      pid: parsed.pid,
    };
    // Only carry `timestamp` through if the on-disk record has one. `isLockSuspect`
    // prefers `timestamp` over `startedAt`, so a fabricated "now" fallback would
    // mask an aged `startedAt` — the very bug the AC8/AC9 boundary tests pin.
    if (typeof parsed.timestamp === "number") record.timestamp = parsed.timestamp;
    if (typeof parsed.startedAt === "string") record.startedAt = parsed.startedAt;
    if (typeof parsed.host === "string" && parsed.host.length > 0) record.host = parsed.host;
    return record;
  } catch {
    return null;
  }
}

/**
 * Read and parse the feature lock at `<outputDir>/features/<feature>/nax.lock`.
 * Returns null when the file is absent, unreadable, or unparseable.
 */
async function readFeatureRecord(outputDir: string, feature: string): Promise<FeatureLockRecord | null> {
  const lockPath = featureLockPath(outputDir, feature);
  if (!existsSync(lockPath)) return null;
  try {
    const content = await Bun.file(lockPath).text();
    const parsed = JSON.parse(content) as FeatureLockRecord;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Check if any lock (checkout or feature) is stale.
 *
 * Without `featureLock`, the check is checkout-only — unchanged from US-001.
 * With `featureLock`, both the checkout lock and the feature lock are
 * evaluated via `isLockSuspect`, and the result message names whichever are
 * stale so an operator can act on each independently.
 */
export async function checkStaleLock(workdir: string, featureLock?: FeatureLockRef): Promise<Check> {
  // Without a featureLock argument, fall back to the legacy checkout-only
  // path so `nax precheck --light` (and any caller without a feature in
  // scope) keeps today's behaviour bit-for-bit.
  if (featureLock === undefined) {
    return checkStaleLockCheckoutOnly(workdir);
  }

  // With a featureLock, apply isLockSuspect to both locks. A lock that isn't
  // present is treated as "no offender" — only the locks actually on disk
  // can be stale.
  const now = Date.now();
  const checkoutPath = `${workdir}/nax.lock`;
  const checkoutExists = existsSync(checkoutPath);
  const featurePath = featureLockPath(featureLock.outputDir, featureLock.feature);
  const featureExists = existsSync(featurePath);

  if (!checkoutExists && !featureExists) {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: true,
      message: "No lock file present",
    };
  }

  // Checkout lock — parse and classify via `isLockSuspect` so the same
  // foreign-vs-local verdict applies as for the feature lock below. Without
  // this unification a foreign-host checkout lock whose PID happens to be
  // alive locally (PID recycling) would be silently treated as "fresh" while
  // a feature-lock predicate would correctly flag it suspect — that's the
  // divergence the semantic reviewer caught.
  const checkoutRecord = checkoutExists ? await readCheckoutRecord(workdir) : null;
  const checkoutSuspect = checkoutRecord !== null && isLockSuspect(checkoutRecord, now);

  // Feature lock — defer entirely to isLockSuspect for the verdict, since
  // the feature-lock record carries its own `host` field and startedAt/timestamp.
  const featureRecord = featureExists ? await readFeatureRecord(featureLock.outputDir, featureLock.feature) : null;
  const featureSuspect = featureRecord !== null && isLockSuspect(featureRecord, now);

  if (!checkoutSuspect && !featureSuspect) {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: true,
      message: checkoutExists
        ? featureExists
          ? "Lock files are fresh"
          : "Lock file is fresh"
        : "No checkout lock present",
    };
  }

  const reasons: string[] = [];
  if (checkoutSuspect) reasons.push("checkout lock");
  if (featureSuspect) reasons.push(`feature lock "${featureLock.feature}"`);
  return {
    name: "no-stale-lock",
    tier: "blocker",
    passed: false,
    message: `stale ${reasons.join(" and ")} detected (over 2 hours old)`,
  };
}

/** Legacy checkout-only check — kept as the no-feature path for `nax plan`. */
async function checkStaleLockCheckoutOnly(workdir: string): Promise<Check> {
  const lockPath = `${workdir}/nax.lock`;
  const exists = existsSync(lockPath);

  if (!exists) {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: true,
      message: "No lock file present",
    };
  }

  try {
    const file = Bun.file(lockPath);
    const content = await file.text();
    const lockData = JSON.parse(content);

    let lockTimeMs: number;
    if (lockData.timestamp) {
      lockTimeMs = lockData.timestamp;
    } else if (lockData.startedAt) {
      lockTimeMs = new Date(lockData.startedAt).getTime();
    } else {
      const stat = statSync(lockPath);
      lockTimeMs = stat.mtimeMs;
    }

    // A live holder is authoritative and immune to wall-clock sleep/NTP skew
    // (which corrupts both the recorded timestamp and the file mtime equally,
    // since both are Date.now()-based). The elapsed-time check is only a
    // backstop for a dead-but-recycled PID.
    const holderAlive = typeof lockData.pid === "number" && isProcessAlive(lockData.pid);
    const ageMs = Date.now() - lockTimeMs;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const passed = holderAlive || ageMs < twoHoursMs;

    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed,
      message: passed ? "Lock file is fresh" : "stale lock detected (over 2 hours old)",
    };
  } catch {
    return {
      name: "no-stale-lock",
      tier: "blocker",
      passed: false,
      message: "Failed to read lock file",
    };
  }
}

/** Validate PRD structure and required fields. Auto-defaults: tags=[], status=pending, storyPoints=1 */
export async function checkPRDValid(prd: PRD): Promise<Check> {
  const errors: string[] = [];

  if (!prd.project || prd.project.trim() === "") {
    errors.push("Missing project field");
  }
  if (!prd.feature || prd.feature.trim() === "") {
    errors.push("Missing feature field");
  }
  if (!prd.branchName || prd.branchName.trim() === "") {
    errors.push("Missing branchName field");
  }
  if (!Array.isArray(prd.userStories)) {
    errors.push("userStories must be an array");
  }

  if (Array.isArray(prd.userStories)) {
    for (const story of prd.userStories) {
      story.tags = story.tags ?? [];
      story.status = story.status ?? "pending";
      story.storyPoints = story.storyPoints ?? 1;
      story.acceptanceCriteria = story.acceptanceCriteria ?? [];

      if (!story.id || story.id.trim() === "") {
        errors.push(`Story missing id: ${JSON.stringify(story).slice(0, 50)}`);
      }
      if (!story.title || story.title.trim() === "") {
        errors.push(`Story ${story.id} missing title`);
      }
      if (!story.description || story.description.trim() === "") {
        errors.push(`Story ${story.id} missing description`);
      }
    }
  }

  const passed = errors.length === 0;

  return {
    name: "prd-valid",
    tier: "blocker",
    passed,
    message: passed ? "PRD structure is valid" : errors.join("; "),
  };
}
