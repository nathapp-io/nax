/**
 * New-Package Setup
 *
 * When a story targets a package that did not exist at run start (new feature on
 * a new package), ensureStoryPackageDirs creates the directory but it is empty —
 * no manifest, no installed dependencies. The implementer scaffolds the manifest
 * (pyproject.toml / package.json / go.mod / Cargo.toml) during its phase, after
 * which the package may need a one-time init step (`uv sync`, `bun install`,
 * `go mod download`) before its tests can run.
 *
 * This module runs `quality.commands.setup` (per-package layerable) exactly once
 * per newly-created package per run, lazily, right before that package's first
 * verify/test gate — which is after the implementer has produced the manifest.
 * Existing packages are never touched: only directories registered via
 * markNewPackageDirs (i.e. created this run) are eligible.
 *
 * The runtime instance is the per-run key for the idempotency registry, so the
 * setup command fires once even though a package may pass through multiple gates
 * (full-suite-gate and verify-scoped) across iterations.
 */

import path from "node:path";
import { getSafeLogger } from "../logger";
import { spawn } from "../utils/bun-deps";
import { parseCommandToArgv } from "../utils/command-argv";

/** Per-run registry: which package dirs are newly created, and which have had setup run. */
const registry = new WeakMap<object, { pending: Set<string>; done: Set<string> }>();

const MAX_SETUP_OUTPUT_CHARS = 2000;

function normalize(dir: string): string {
  return path.resolve(dir);
}

/**
 * Record package directories created this run as eligible for one-time setup.
 * Keyed by the run's runtime instance.
 */
export function markNewPackageDirs(runtime: object | undefined, absDirs: readonly string[]): void {
  if (!runtime || absDirs.length === 0) return;
  let slot = registry.get(runtime);
  if (!slot) {
    slot = { pending: new Set<string>(), done: new Set<string>() };
    registry.set(runtime, slot);
  }
  for (const dir of absDirs) slot.pending.add(normalize(dir));
}

/**
 * Claim the one-time setup for a package. Returns true exactly once for a
 * pending (newly-created), not-yet-setup package; false otherwise. Marks the
 * package done on claim so concurrent/repeat gate calls do not re-run setup.
 */
function claimSetup(runtime: object, absPackageDir: string): boolean {
  const slot = registry.get(runtime);
  if (!slot) return false;
  const key = normalize(absPackageDir);
  if (!slot.pending.has(key) || slot.done.has(key)) return false;
  slot.done.add(key);
  return true;
}

/** Injectable process spawn for testability. */
export const _newPackageSetupDeps = { spawn };

/**
 * Run `quality.commands.setup` for a newly-created package, once. No-op when the
 * package was not created this run, setup is already done, or no command is
 * configured. Failures are logged (warn) and swallowed — the subsequent verify
 * gate surfaces the real impact rather than this helper changing gate control flow.
 */
export async function maybeRunNewPackageSetup(opts: {
  runtime: object | undefined;
  storyId: string;
  packageDir: string;
  setupCommand: string | undefined;
}): Promise<void> {
  const { runtime, storyId, packageDir, setupCommand } = opts;
  if (!runtime || !setupCommand) return;
  if (!claimSetup(runtime, packageDir)) return;

  const argv = parseCommandToArgv(setupCommand);
  if (argv.length === 0) return;

  const logger = getSafeLogger();
  logger?.info("setup", "Running setup for newly-created package", { storyId, packageDir, command: setupCommand });

  try {
    const proc = _newPackageSetupDeps.spawn(argv, { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      const output = [stdout, stderr].filter(Boolean).join("\n").slice(-MAX_SETUP_OUTPUT_CHARS);
      logger?.warn("setup", "Package setup command failed — continuing; verification will surface the impact", {
        storyId,
        packageDir,
        exitCode,
        output,
      });
      return;
    }
    logger?.debug("setup", "Package setup complete", { storyId, packageDir });
  } catch (err) {
    logger?.warn("setup", "Package setup command threw — continuing", {
      storyId,
      packageDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
