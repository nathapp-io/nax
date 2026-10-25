/**
 * nax#2552: put the snapshot-time ignore rules back before the restore-time working-tree comparison.
 *
 * The comparison runs `git add -A` into a throwaway index, which honours the .gitignore files as
 * they are NOW. A reviewer that appended `planted*` to .gitignore (or created a `sub/.gitignore`
 * holding `*`) would make its own files invisible to the comparison and survive the restore. So
 * every .gitignore the snapshot tree knows is reset to its snapshot content and every .gitignore
 * the reviewer added is removed, and only then is the working tree compared. The repo-level
 * `.git/info/exclude` and `core.excludesFile` are outside this reset: the sandbox denies
 * `.git/info` and `.git/config` (policy-builder gitDenies), so a sandboxed reviewer cannot move them.
 */
import { basename, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { git, gitRaw } from "./deps";

const IGNORE_FILE = ".gitignore";
const IGNORE_PATHSPEC = `:(top,glob)**/${IGNORE_FILE}`;
const CHUNK = 500;

/** One snapshot-tree entry: its git object type ("commit" = gitlink) and blob id. */
export interface TreeEntry {
  readonly type: string;
  readonly sha: string;
}

export interface IgnoreRuleRestore {
  readonly toplevel: string;
  readonly tree: string;
  readonly entries: ReadonlyMap<string, TreeEntry>;
  /**
   * Every .gitignore present when the snapshot was taken, ignored ones included (`node_modules/x/.gitignore`,
   * `.pytest_cache/.gitignore`). Only a .gitignore outside this list is the reviewer's and removed. `null`
   * (the list could not be read) still removes every VISIBLE added one — the snapshot tree holds every
   * visible file, so those can only be the reviewer's — and keeps only the ignored ones, as a failure.
   */
  readonly known: ReadonlySet<string> | null;
  readonly skip: (path: string) => boolean;
  readonly remove: (absolutePath: string) => Promise<void>;
}

export async function listIgnoreFiles(toplevel: string): Promise<Set<string>> {
  // Visible files (tracked + untracked) and the ones a rule hides, e.g. a nested `*` file hiding itself.
  const [visible, hidden] = await Promise.all([
    gitRaw(["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", IGNORE_PATHSPEC], toplevel),
    gitRaw(["ls-files", "-z", "-o", "-i", "--exclude-standard", "--", IGNORE_PATHSPEC], toplevel),
  ]);
  return new Set([...visible.split("\0"), ...hidden.split("\0")].filter(isIgnoreFile));
}

/**
 * git does not descend into a nested repository or worktree; `ls-files -o` reports the directory
 * itself (`.nax-wt/bot-x/`) whatever the pathspec. Taken for a reviewer-added .gitignore, it was
 * deleted recursively (nax#2681). Only a path whose basename is exactly `.gitignore` is one.
 */
function isIgnoreFile(p: string): boolean {
  return !p.endsWith("/") && basename(p) === IGNORE_FILE;
}

async function listVisibleIgnoreFiles(toplevel: string): Promise<Set<string>> {
  const visible = await gitRaw(["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", IGNORE_PATHSPEC], toplevel);
  return new Set(visible.split("\0").filter(isIgnoreFile));
}

async function currentShas(toplevel: string, paths: readonly string[]): Promise<Map<string, string>> {
  const shas = new Map<string, string>();
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const lines = (await git(["hash-object", "--no-filters", "--", ...chunk], toplevel)).split("\n");
    for (const [j, p] of chunk.entries()) shas.set(p, lines[j] ?? "");
  }
  return shas;
}

/** Reset every .gitignore to its snapshot state; returns the paths changed. Failures are recorded, never thrown. */
export async function restoreIgnoreRules(ctx: IgnoreRuleRestore, failures: string[]): Promise<string[]> {
  const { toplevel, tree, entries } = ctx;
  try {
    const current = [...(await listIgnoreFiles(toplevel))].filter((p) => !ctx.skip(p));
    const wanted = [...entries]
      .filter(([p, e]) => basename(p) === IGNORE_FILE && e.type !== "commit" && !ctx.skip(p))
      .map(([p]) => p);
    const wantedSet = new Set(wanted);
    const known = ctx.known ?? (await listVisibleIgnoreFiles(toplevel));
    if (ctx.known === null) failures.push("ignore-rules: snapshot-time .gitignore list unavailable; ignored ones kept");
    const added =
      ctx.known === null
        ? current.filter((p) => !wantedSet.has(p) && known.has(p))
        : current.filter((p) => !wantedSet.has(p) && !known.has(p));
    for (const p of added) {
      await ctx.remove(join(toplevel, p)).catch((err) => failures.push(`remove ${p}: ${errorMessage(err)}`));
    }
    const present = new Set(current);
    const live = wanted.filter((p) => present.has(p));
    const shas = await currentShas(toplevel, live);
    const stale = wanted.filter((p) => !present.has(p) || shas.get(p) !== entries.get(p)?.sha);
    for (let i = 0; i < stale.length; i += CHUNK) {
      const chunk = stale.slice(i, i + CHUNK);
      await git(["checkout", tree, "--", ...chunk.map((p) => `:(top,literal)${p}`)], toplevel).catch((err) =>
        failures.push(`checkout ${chunk.length} ignore file(s): ${errorMessage(err)}`),
      );
    }
    return [...added, ...stale];
  } catch (err) {
    failures.push(`ignore-rules: ${errorMessage(err)}`);
    return [];
  }
}
