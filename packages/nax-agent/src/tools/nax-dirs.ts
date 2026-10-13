/**
 * Where nax's run state (`.nax/`) lives, for the Bash guard (#2490, #2493).
 *
 * A `.nax/` is looked for at the root, at every working-directory frame and
 * between a frame and the root, and BELOW the root: a package-level `.nax`
 * (monorepo workdir) is nax state just as much as the root one. The downward
 * scan is bounded (depth 3 under the root, never into `node_modules` or a
 * dot-directory other than `.nax`) and cached in a `NaxDirIndex` that the
 * policy creates once per compile.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Where a segment runs: every live working-directory frame, and the permitted root. */
export interface NaxGuardContext {
  readonly frames: readonly string[];
  readonly root: string;
  /** Shared downward-scan cache; absent means every lookup scans afresh. */
  readonly naxDirs?: NaxDirIndex;
}

/** How deep below the root a nested `.nax` is looked for. */
const MAX_NESTED_DEPTH = 3;

/** Directory names the downward scan never enters. */
function isSkipped(name: string): boolean {
  return name === "node_modules" || (name.startsWith(".") && name !== ".nax");
}

/** `.nax` directories in `dir` (at `depth` below the root) and in its subdirectories, within the bound. */
function scanDown(dir: string, depth: number, found: string[]): void {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".nax") found.push(join(dir, entry.name));
    else if (depth < MAX_NESTED_DEPTH && !isSkipped(entry.name)) scanDown(join(dir, entry.name), depth + 1, found);
  }
}

/** Every `.nax` directory at or below `root`, within the depth bound. */
export function scanNaxDirs(root: string): readonly string[] {
  const found: string[] = [];
  scanDown(root, 0, found);
  return found;
}

/** Lazily scanned, per-root cache of the `.nax` directories at or below a root. */
export interface NaxDirIndex {
  below(root: string): readonly string[];
}

export function createNaxDirIndex(): NaxDirIndex {
  const byRoot = new Map<string, readonly string[]>();
  return {
    below(root) {
      const cached = byRoot.get(root);
      if (cached !== undefined) return cached;
      const scanned = scanNaxDirs(root);
      byRoot.set(root, scanned);
      return scanned;
    },
  };
}

/** The root, every frame, and every directory between a frame and the root. */
function candidateDirs(ctx: NaxGuardContext): Set<string> {
  const candidates = new Set<string>([ctx.root]);
  for (const frame of ctx.frames) {
    let dir = frame;
    candidates.add(dir);
    while (dir !== ctx.root && dir.startsWith(`${ctx.root}${sep}`)) {
      dir = resolve(dir, "..");
      candidates.add(dir);
    }
  }
  return candidates;
}

function nearNaxDirs(ctx: NaxGuardContext): string[] {
  return [...candidateDirs(ctx)].map((dir) => join(dir, ".nax")).filter((dir) => existsSync(dir));
}

function nestedNaxDirs(ctx: NaxGuardContext): readonly string[] {
  return (ctx.naxDirs ?? { below: scanNaxDirs }).below(ctx.root);
}

/** Every known `.nax` directory: on the way from a frame to the root, at the root, or nested below it. */
export function findNaxDirs(ctx: NaxGuardContext): readonly string[] {
  return [...new Set([...nearNaxDirs(ctx), ...nestedNaxDirs(ctx)])];
}

/** True when a `.nax/` exists at a frame, between a frame and the root, at the root, or nested below it. */
export function hasNaxDirNear(ctx: NaxGuardContext): boolean {
  return nearNaxDirs(ctx).length > 0 || nestedNaxDirs(ctx).length > 0;
}
