/**
 * The manifest/lockfile pair a workspace package manager writes, keyed by
 * the same manager identity `package-managers.ts` classifies argv against.
 *
 * Populated only from `run-command-exec.ts`, and only after `runArgv`
 * resolves with a real success (exit 0, not timed out) for a call
 * `classifyExec` already recognized as install-shaped — never from anything
 * the model wrote directly. See `resolveWithin` in `src/tools/policy.ts` for
 * how the recorded paths are consumed.
 *
 * pip has no entry: it does not write a lockfile-shaped artifact the way the
 * other managers here do, so there is nothing for this carve-out to record.
 */
import { resolve } from "node:path";

interface ManifestLockfile {
  readonly manifest: string;
  readonly lockfile?: string;
}

const MANIFEST_LOCKFILE: Readonly<Record<string, ManifestLockfile>> = {
  bun: { manifest: "package.json", lockfile: "bun.lock" },
  npm: { manifest: "package.json", lockfile: "package-lock.json" },
  pnpm: { manifest: "package.json", lockfile: "pnpm-lock.yaml" },
  yarn: { manifest: "package.json", lockfile: "yarn.lock" },
  cargo: { manifest: "Cargo.toml", lockfile: "Cargo.lock" },
  uv: { manifest: "pyproject.toml", lockfile: "uv.lock" },
  go: { manifest: "go.mod", lockfile: "go.sum" },
};

/**
 * Appends the absolute manifest and lockfile paths for `manager` at `cwd`
 * onto `target`, deduplicated. A no-op for an unrecognized manager (`pip`,
 * or anything `package-managers.ts` does not classify as install-shaped).
 *
 * `target` is mutated in place rather than returned: it is the same array
 * reference `compileToolPolicy`'s `execTouchedPaths` option was given, so a
 * push here is visible to every policy check made against that same
 * dispatch hop from this point on.
 */
export function recordExecTouchedPaths(target: string[], manager: string, cwd: string): void {
  const entry = MANIFEST_LOCKFILE[manager];
  if (entry === undefined) return;
  const names = entry.lockfile === undefined ? [entry.manifest] : [entry.manifest, entry.lockfile];
  for (const name of names) {
    const path = resolve(cwd, name);
    if (!target.includes(path)) target.push(path);
  }
}
