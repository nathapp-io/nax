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

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import chalk from "chalk";
import { findProjectDir, loadConfig } from "@/config";
import { type FeatureLockRecord, featureLockPath, isLockSuspect } from "@/execution";
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
};

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
    console.error(chalk.red(`Failed to parse feature lock: ${lockPath}`));
    return "parse-error";
  }

  const now = Date.now();
  const suspect = isLockSuspect(record, now);
  if (!force && !suspect) {
    console.error(
      chalk.red(
        `nax is still running on feature "${feature}" (PID ${record.pid}${record.host ? `, host ${record.host}` : ""}). Use --force to override.`,
      ),
    );
    return "skipped";
  }

  const ageMs = typeof record.timestamp === "number" ? now - record.timestamp : 0;
  console.log(
    `${force && !suspect ? "Forced removal of" : "Stale"} feature lock: feature=${feature} PID=${record.pid} age=${formatLockAge(ageMs)}`,
  );

  try {
    await unlink(lockPath);
  } catch (error) {
    console.error(
      chalk.red(`Failed to remove feature lock: ${error instanceof Error ? error.message : String(error)}`),
    );
    return "skipped";
  }
  await Bun.sleep(10);
  return "removed";
}

/**
 * List feature names that currently have a lock file under
 * `<outputDir>/features/<feature>/nax.lock`. Returns names sorted ascending.
 */
function listFeatureLockFeatures(outputDir: string): string[] {
  const featuresRoot = join(outputDir, "features");
  let entries: { name: string }[];
  try {
    entries = readdirSync(featuresRoot, { withFileTypes: true }) as { name: string }[];
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith(".")) continue;
    const lockPath = join(featuresRoot, entry.name, "nax.lock");
    try {
      // statSync would be cheaper but we want to fail closed on every
      // error (EACCES, ENOTDIR, …), so a one-shot read is fine.
      readFileSync(lockPath);
      names.push(entry.name);
    } catch {
      // Missing or unreadable — skip silently; the scan will only see
      // names that have a lock file we can actually stat.
    }
  }
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
    mkdirSync(join(outputDir, "features"), { recursive: true });

    const outcome = await tryRemoveFeatureLock(outputDir, options.feature, options.force ?? false);
    if (outcome === "skipped" || outcome === "parse-error") {
      process.exit(1);
    }
    console.log("Feature lock removed");
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
      console.error(chalk.red("Failed to parse lock file"));
      checkoutAborted = true;
      lockData = undefined;
    }

    if (lockData !== undefined) {
      const { pid, timestamp } = lockData;
      const ageMs = Date.now() - (timestamp ?? Date.now());

      // Check if process is alive (unless --force)
      if (!options.force) {
        if (isProcessAlive(pid)) {
          console.error(chalk.red(`nax is still running (PID ${pid}). Use --force to override.`));
          process.exit(1);
        }
      }

      // Print lock info before removing
      console.log(`Stale lock found (PID ${pid}, age: ${formatLockAge(ageMs)})`);

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
          console.log("Lock file disappeared before removal — nothing to do");
          process.exit(0);
        }
        if (currentLockData.pid !== pid) {
          console.error(
            chalk.red(
              `Lock now held by a different PID (${currentLockData.pid}) — refusing to remove. Re-run nax unlock.`,
            ),
          );
          process.exit(1);
        }
      }

      // Remove lock file — native unlink, not a shelled-out `rm` (portable across
      // systems/PATHs without an `rm` binary).
      try {
        await unlink(checkoutLockPath);
      } catch (error) {
        console.error(chalk.red(`Failed to remove lock: ${error instanceof Error ? error.message : String(error)}`));
        checkoutAborted = true;
      }
      // Wait a bit for filesystem to sync (prevents race in tests)
      await Bun.sleep(10);
      if (!checkoutAborted) {
        console.log("Lock removed");
      }
    }
  } else {
    console.log("No lock file found");
  }

  // Feature-lock scan — runs whether or not the checkout lock existed.
  // Only reachable when the project is initialised; otherwise we silently
  // skip (no outputDir to scan). Failure of any single lock (parse error,
  // live holder, unlink failure) is reported but does not abort the scan.
  let scannedCount = 0;
  let skippedCount = 0;
  try {
    const { outputDir } = await resolveOutputDir(workdir);
    const features = listFeatureLockFeatures(outputDir);
    for (const feature of features) {
      scannedCount++;
      const outcome = await tryRemoveFeatureLock(outputDir, feature, options.force ?? false);
      if (outcome !== "removed") {
        skippedCount++;
      }
    }
    if (scannedCount === 0) {
      console.log("No feature locks found");
    } else {
      console.log(
        `Feature lock scan: ${scannedCount - skippedCount} removed, ${skippedCount} skipped${
          options.force ? " (--force)" : ""
        }`,
      );
    }
  } catch {
    // resolveOutputDir/listFeatureLockFeatures threw — likely because the
    // project is not initialised. That's fine: we already handled the
    // checkout lock above; a feature scan is opt-in by having run setup.
  }

  process.exit(checkoutAborted ? 1 : 0);
}
