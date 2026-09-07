/**
 * The manifest/lockfile pair a workspace package manager writes, keyed by
 * the same manager identity `package-managers.ts` classifies argv against.
 *
 * This is the SINGLE closed table for "what filename looks like a manifest
 * or lockfile" — used two ways:
 *
 * - `snapshotExecTouchedPaths` / `recordExecTouchedPaths` (write side):
 *   compare the closed candidate set before and after a successful install,
 *   recording only files whose contents were actually created or changed.
 *   See `resolveWithin` in `src/tools/policy.ts` for how they are consumed.
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
import { readFile } from "node:fs/promises";
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

type PathState = { readonly kind: "missing" | "unreadable" } | { readonly kind: "present"; readonly contents: string };

export interface ExecTouchedPathSnapshot {
  readonly paths: ReadonlyMap<string, PathState>;
}

export const _execTouchedPathDeps = { readFile };

function candidatePaths(manager: string, cwd: string): readonly string[] {
  const entry = MANIFEST_LOCKFILE[manager];
  return entry === undefined ? [] : [entry.manifest, ...entry.lockfiles].map((name) => resolve(cwd, name));
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readPathState(path: string): Promise<PathState> {
  try {
    return { kind: "present", contents: (await _execTouchedPathDeps.readFile(path)).toString("base64") };
  } catch (error) {
    return { kind: isMissingError(error) ? "missing" : "unreadable" };
  }
}

export async function snapshotExecTouchedPaths(manager: string, cwd: string): Promise<ExecTouchedPathSnapshot> {
  const entries = await Promise.all(
    candidatePaths(manager, cwd).map(async (path) => [path, await readPathState(path)] as const),
  );
  return { paths: new Map(entries) };
}

/**
 * Appends paths whose post-install contents differ from the pre-install
 * snapshot, deduplicated. Missing and unreadable post-install files are never
 * granted; an unreadable pre-install file also fails closed.
 *
 * `target` is mutated in place rather than returned: it is the same array
 * reference `compileToolPolicy`'s `execTouchedPaths` option was given, so a
 * push here is visible to every policy check made against that same
 * dispatch hop from this point on.
 */
export async function recordExecTouchedPaths(target: string[], before: ExecTouchedPathSnapshot): Promise<void> {
  for (const [path, previous] of before.paths) {
    const current = await readPathState(path);
    const changed =
      current.kind === "present" &&
      (previous.kind === "missing" || (previous.kind === "present" && previous.contents !== current.contents));
    if (changed && !target.includes(path)) target.push(path);
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
