/**
 * Unlock command implementation
 *
 * Releases stale locks from crashed nax processes.
 * Checks if lock-holding process is still alive before removing.
 *
 * US-003: gains a `-f, --feature <name>` option that scopes the unlock to
 * `<outputDir>/features/<feature>/nax.lock` (resolved via the findProjectDir
 * → loadConfig → projectOutputDir chain, mirroring src/commands/resume.ts).
 * Without a feature the command still handles the checkout lock and
 * additionally scans `<outputDir>/features/<feature>/nax.lock` for every
 * existing feature, removing only those `isLockSuspect` accepts (or all of
 * them with `--force`).
 */

import { mkdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { findProjectDir, loadConfig } from "@/config";
import { type FeatureLockRecord, featureLockPath, isLockSuspect } from "@/execution";
import { getSafeLogger, type Logger } from "@/logger";
import { projectOutputDir } from "@/runtime";
import { isProcessAlive } from "@/utils/process-alive";

/**
 * Options for unlock command
 */
export interface UnlockOptions {
  /** Explicit project directory (from -d flag) */
  dir?: string;
  /** Force unlock without liveness check (from --force flag) */
  force?: boolean;
  /** Feature name (from -f flag) — scopes unlock to <outputDir>/features/<feature>/nax.lock */
  feature?: string;
}

/**
 * Injectable seams — mirrors the `_lockDeps` and `_featureLockDeps` pattern
 * so tests can resolve a fake projectDir and outputDir without touching the
 * real home-scoped nax directory, and can control PID liveness / suspicion
 * verdicts.
 */
export const _unlockDeps = {
  findProjectDir: findProjectDir as typeof findProjectDir,
  loadConfig: loadConfig as typeof loadConfig,
  projectOutputDir: projectOutputDir as typeof projectOutputDir,
  getSafeLogger: (): Pick<Logger, "info" | "error"> | null => getSafeLogger(),
};

const UNLOCK_LOG_STAGE = "unlock";

function logUnlockInfo(message: string): void {
  _unlockDeps.getSafeLogger()?.info(UNLOCK_LOG_STAGE, message);
}

function logUnlockError(message: string): void {
  _unlockDeps.getSafeLogger()?.error(UNLOCK_LOG_STAGE, message);
}

/**
 * Format lock age in minutes
 */
function formatLockAge(ageMs: number): string {
  const minutes = Math.round(ageMs / (60 * 1000));
  return `${minutes} min`;
}

/**
 * Parse a feature-lock record from on-disk JSON content. Returns null when
 * content is missing, unreadable, or unparseable — callers treat null as
 * "no actionable signal" rather than crashing.
 */
function parseFeatureLockRecord(raw: string): FeatureLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as FeatureLockRecord;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Compute the project's output directory from `workdir`, mirroring the
 * findProjectDir → loadConfig → projectOutputDir chain used by
 * `src/commands/resume.ts`. Throws when the project isn't initialised.
 */
async function resolveOutputDir(workdir: string): Promise<{ outputDir: string; naxDir: string | null }> {
  const naxDir = _unlockDeps.findProjectDir(workdir);
  const config = await _unlockDeps.loadConfig(naxDir ?? undefined);
  const projectKey = config.name?.trim() || basename(workdir);
  const outputDir = _unlockDeps.projectOutputDir(projectKey, config.outputDir);
  return { outputDir, naxDir };
}

/**
 * Try to remove a feature lock at `featureLockPath(...)` whose JSON content
 * matches `isLockSuspect`. Prints a one-line summary either way so the
 * operator sees what happened. With `--force` removes regardless.
 *
 * Returns:
 *   "removed" — lock file was successfully removed (or wasn't there)
 *   "skipped" — lock file held a live holder and --force wasn't set
 *   "parse-error" — file existed but couldn't be parsed
 */
async function tryRemoveFeatureLock(
  outputDir: string,
  feature: string,
  force: boolean,
): Promise<"removed" | "skipped" | "parse-error"> {
  const lockPath = featureLockPath(outputDir, feature);
  const lockFile = Bun.file(lockPath);
  const exists = await lockFile.exists();
  if (!exists) return "removed";

  const raw = await lockFile.text();
  const record = parseFeatureLockRecord(raw);
  if (record === null) {
    logUnlockError(`Failed to parse feature lock: ${lockPath}`);
    return "parse-error";
  }

  const now = Date.now();
  const suspect = isLockSuspect(record, now);
  if (!force && !suspect) {
    logUnlockError(
      `nax is still running on feature "${feature}" (PID ${record.pid}${record.host ? `, host ${record.host}` : ""}). Use --force to override.`,
    );
    return "skipped";
  }

  const ageMs = typeof record.timestamp === "number" ? now - record.timestamp : 0;
  logUnlockInfo(
    `${force && !suspect ? "Forced removal of" : "Stale"} feature lock: feature=${feature} PID=${record.pid} age=${formatLockAge(ageMs)}`,
  );

  try {
    await unlink(lockPath);
  } catch (error) {
    logUnlockError(`Failed to remove feature lock: ${error instanceof Error ? error.message : String(error)}`);
    return "skipped";
  }
  return "removed";
}

/**
 * List feature names that currently have a lock file under
 * `<outputDir>/features/<feature>/nax.lock`. Returns names sorted ascending.
 */
async function listFeatureLockFeatures(outputDir: string): Promise<string[]> {
  const featuresRoot = join(outputDir, "features");
  let paths: string[];
  try {
    paths = await Array.fromAsync(new Bun.Glob("*/nax.lock").scan({ cwd: featuresRoot, onlyFiles: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = paths
    .map((lockPath) => lockPath.split("/")[0])
    .filter((name): name is string => Boolean(name) && !name.startsWith("."));
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

/**
 * Run unlock command
 *
 * Reads nax.lock, checks if holding process is alive, and removes lock if safe.
 * Exits with code 0 on success, 1 on failure.
 *
 * US-003: when `options.feature` is provided the unlock is scoped to that
 * feature's lock under `<outputDir>/features/<feature>/nax.lock`. Without a
 * feature, the command handles the checkout lock as before AND scans the
 * features directory for stale feature locks, removing only those
 * `isLockSuspect` accepts (or all of them with `--force`).
 */
export async function unlockCommand(options: UnlockOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();

  // Feature-scoped path: resolve <outputDir>/features/<feature>/nax.lock via
  // the findProjectDir → loadConfig → projectOutputDir chain. No checkout
  // lock is touched here — a feature-scoped unlock stays feature-scoped.
  if (options.feature !== undefined && options.feature.length > 0) {
    const { outputDir } = await resolveOutputDir(workdir);
    await mkdir(join(outputDir, "features"), { recursive: true });

    const outcome = await tryRemoveFeatureLock(outputDir, options.feature, options.force ?? false);
    if (outcome === "skipped" || outcome === "parse-error") {
      process.exit(1);
    }
    logUnlockInfo("Feature lock removed");
    process.exit(0);
  }

  // Default path: handle the checkout lock first (existing behaviour), then
  // scan the features directory for stale feature locks. The scan runs
  // whether or not the checkout lock exists — a project without an init
  // might still have leftover feature locks from an earlier init.
  const checkoutLockPath = join(workdir, "nax.lock");
  let checkoutAborted = false;
  const lockFile = Bun.file(checkoutLockPath);
  const exists = await lockFile.exists();

  if (exists) {
    // Read lock file
    let lockData: { pid: number; timestamp: number } | undefined;
    try {
      const lockContent = await lockFile.text();
      lockData = JSON.parse(lockContent);
    } catch {
      logUnlockError("Failed to parse lock file");
      checkoutAborted = true;
      lockData = undefined;
    }

    if (lockData !== undefined) {
      const { pid, timestamp } = lockData;
      const ageMs = Date.now() - (timestamp ?? Date.now());

      // Check if process is alive (unless --force)
      if (!options.force) {
        if (isProcessAlive(pid)) {
          logUnlockError(`nax is still running (PID ${pid}). Use --force to override.`);
          process.exit(1);
        }
      }

      // Print lock info before removing
      logUnlockInfo(`Stale lock found (PID ${pid}, age: ${formatLockAge(ageMs)})`);

      // TOCTOU guard: re-read the lock file and re-verify the PID immediately before
      // deleting it. A new run could have acquired the lock in the window between the
      // liveness check above and this point — deleting unconditionally would wrongly
      // remove that new run's lock. Only delete if the PID we're about to remove is
      // still the one on disk.
      if (!options.force) {
        let currentLockData: { pid: number; timestamp: number };
        try {
          const currentContent = await Bun.file(checkoutLockPath).text();
          currentLockData = JSON.parse(currentContent);
        } catch {
          logUnlockInfo("Lock file disappeared before removal — nothing to do");
          process.exit(0);
        }
        if (currentLockData.pid !== pid) {
          logUnlockError(
            `Lock now held by a different PID (${currentLockData.pid}) — refusing to remove. Re-run nax unlock.`,
          );
          process.exit(1);
        }
      }

      // Remove lock file — native unlink, not a shelled-out `rm` (portable across
      // systems/PATHs without an `rm` binary).
      try {
        await unlink(checkoutLockPath);
      } catch (error) {
        logUnlockError(`Failed to remove lock: ${error instanceof Error ? error.message : String(error)}`);
        checkoutAborted = true;
      }
      if (!checkoutAborted) {
        logUnlockInfo("Lock removed");
      }
    }
  } else {
    logUnlockInfo("No lock file found");
  }

  // Feature-lock scan — runs whether or not the checkout lock existed.
  //
  // Only reachable when the project is initialised; the "not initialised"
  // case is the one explicitly benign skip here, since a `nax unlock`
  // invoked against a directory that never ran `nax init` has no feature
  // tree to scan. Any other failure (loadConfig rejecting a corrupt config,
  // projectOutputDir throwing CONFIG_INVALID for a relative `outputDir`
  // override, an unexpected filesystem error inside the scan) is a real
  // problem and must surface — the previous bare `catch {}` silently hid
  // permission errors and CONFIG_INVALID behind a successful "Lock removed"
  // exit, leaving operators to think the unlock worked.
  //
  // Per-feature failures inside `tryRemoveFeatureLock` are already reported
  // as `"skipped"` (parse error, live holder, unlink failure) and do NOT
  // abort the scan — only exceptional throws above the per-feature loop
  // escalate.
  if (_unlockDeps.findProjectDir(workdir) === null) {
    // Project isn't initialised — there is no `<outputDir>/features/` tree
    // to scan, and forcing a resolve would either read DEFAULT_CONFIG (a
    // mis-anchored path keyed off `basename(workdir)`) or throw on a
    // CONFIG_INVALID `outputDir` override. Both outcomes would be misleading.
    process.exit(checkoutAborted ? 1 : 0);
  }

  let scannedCount = 0;
  let skippedCount = 0;
  let scanError: unknown;
  try {
    const { outputDir } = await resolveOutputDir(workdir);
    const features = await listFeatureLockFeatures(outputDir);
    for (const feature of features) {
      scannedCount++;
      const outcome = await tryRemoveFeatureLock(outputDir, feature, options.force ?? false);
      if (outcome !== "removed") {
        skippedCount++;
      }
    }
  } catch (err) {
    // Surface the error to the operator and exit non-zero so the
    // checkout-lock handling above is not reported as a clean success.
    scanError = err;
  }

  if (scanError !== undefined) {
    const message = scanError instanceof Error ? scanError.message : String(scanError);
    logUnlockError(`Feature lock scan failed: ${message}`);
    process.exit(1);
  }

  if (scannedCount === 0) {
    logUnlockInfo("No feature locks found");
  } else {
    logUnlockInfo(
      `Feature lock scan: ${scannedCount - skippedCount} removed, ${skippedCount} skipped${options.force ? " (--force)" : ""}`,
    );
  }

  process.exit(checkoutAborted ? 1 : 0);
}
