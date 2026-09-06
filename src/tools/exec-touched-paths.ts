/**
 * The manifest/lockfile pair a workspace package manager writes, keyed by
 * the same manager identity `package-managers.ts` classifies argv against.
 *
 * This is the SINGLE closed table for "what filename looks like a manifest
 * or lockfile" — used two ways:
 *
 * - `recordExecTouchedPaths` (write side): populated only from
 *   `run-command-exec.ts`, and only after `runArgv` resolves with a real
 *   success (exit 0, not timed out) for a call `classifyExec` already
 *   recognized as install-shaped — never from anything the model wrote
 *   directly. See `resolveWithin` in `src/tools/policy.ts` for how the
 *   recorded paths are consumed.
 * - `isKnownManifestOrLockfileName` (message side): lets a policy denial
 *   recognize that a refused path merely LOOKS like a manifest/lockfile, so
 *   it can explain the containment rule instead of returning a bare refusal
 *   (fix round 1, Task 10) — this recognizes the *shape* only, never grants
 *   anything by itself.
 *
 * pip has no entry: it does not write a lockfile-shaped artifact the way the
 * other managers here do, so there is nothing for this carve-out to record
 * or recognize.
 */
import { resolve } from "node:path";

interface ManifestLockfile {
  readonly manifest: string;
  /** bun has shipped both the binary (`bun.lockb`) and text (`bun.lock`) formats. */
  readonly lockfiles: readonly string[];
}

const MANIFEST_LOCKFILE: Readonly<Record<string, ManifestLockfile>> = {
  bun: { manifest: "package.json", lockfiles: ["bun.lock", "bun.lockb"] },
  npm: { manifest: "package.json", lockfiles: ["package-lock.json"] },
  pnpm: { manifest: "package.json", lockfiles: ["pnpm-lock.yaml"] },
  yarn: { manifest: "package.json", lockfiles: ["yarn.lock"] },
  cargo: { manifest: "Cargo.toml", lockfiles: ["Cargo.lock"] },
  uv: { manifest: "pyproject.toml", lockfiles: ["uv.lock"] },
  go: { manifest: "go.mod", lockfiles: ["go.sum"] },
};

const ALL_MANIFEST_LOCKFILE_NAMES: ReadonlySet<string> = new Set(
  Object.values(MANIFEST_LOCKFILE).flatMap((entry) => [entry.manifest, ...entry.lockfiles]),
);

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
  for (const name of [entry.manifest, ...entry.lockfiles]) {
    const path = resolve(cwd, name);
    if (!target.includes(path)) target.push(path);
  }
}

/**
 * True when `name` (a bare filename, e.g. from `basename(candidate)`) is one
 * this table recognizes as a manifest or lockfile for ANY known manager.
 *
 * Recognizing the shape is not the same as granting anything: this answers
 * "would a denial here benefit from explaining the Exec carve-out", nothing
 * more. A path with this shape can still be refused outright — it is a hint
 * for the message, never a second containment check.
 */
export function isKnownManifestOrLockfileName(name: string): boolean {
  return ALL_MANIFEST_LOCKFILE_NAMES.has(name);
}
