/**
 * US-006 — the placeholder-shaped paths a broad `git add` must never stage.
 *
 * On Linux, bwrap creates a mount placeholder at a deny path that is ABSENT: an
 * empty 0444 file (or an empty directory) at `.mcp.json`, `.bashrc`,
 * `.claude/settings.json` and the rest. A placeholder left behind while a
 * sandboxed command runs — or by a process killed before its own cleanup — is
 * the exact shape of a file a broad staging pass (`git add -A`, nax's auto
 * commit, a review snapshot) would commit: an empty `.mcp.json` or `.gitmodules`
 * in the user's history, silently.
 *
 * So this module answers one question for the staging path: which of the paths
 * nax protects currently hold a **file** placeholder that git does not already
 * track? The answer is a list of paths relative to `cwd`, ready to become
 * `:(exclude,literal)` pathspecs on the `git add` that `gitlinkSafeAdd` runs.
 *
 * Only two sources count, because only they are paths nax knows a sandbox may
 * place a placeholder at: srt's mandatory write-deny files, and the entries of
 * the trusted process ledger (US-002). A path git already tracks is never
 * excluded — a tracked `.gitmodules` the agent legitimately empties must still
 * stage, and the placeholder at an untracked name is the only one that could
 * enter history by accident.
 *
 * Directories are deliberately absent from the result: git stages no directory,
 * so an empty placeholder directory cannot be committed (US-006 scope). The
 * caller passes the paths its own `ls-files --stage` listing printed — every
 * mode, not just the gitlinks.
 *
 * Synchronous `node:fs` throughout, as the rest of the placeholder modules are:
 * it runs inside the staging helper, which is synchronous up to its git spawns
 * (nax-agent is a Node library and uses no Bun API).
 */
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SRT_MANDATORY_DENY_FILES } from "./defaults.ts";
import { _placeholderDeps } from "./placeholder-deps.ts";
import { readLedgerFile } from "./placeholder-ledger.ts";
import { placeholderIdentity } from "./placeholder-paths.ts";

/** `target` is `root` itself or lies beneath it — by path segment, so `/xy` is not under `/x`. */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Every entry path recorded by a ledger this process may trust.
 *
 * A ledger that fails the trust check is ignored whole (`readLedgerFile` owns
 * that decision), and so is every file in the directory that is not a `.json`
 * ledger — the same filter the sweep applies, which keeps its warn-per-refusal
 * meaningful. Any failure to read the directory yields no entries: the caller
 * still has the mandatory names, which is the documented fallback.
 */
function ledgerEntryPaths(): string[] {
  let dir: string;
  let names: string[];
  try {
    dir = _placeholderDeps.ledgerDir();
    names = readdirSync(dir);
  } catch {
    // `credentialsConfig()` throws until the host configures it, and the
    // directory may simply not exist yet. Neither is an error here: US-006's
    // fallback is the mandatory names, and staging must never be blocked by a
    // guard whose sources are unavailable.
    return [];
  }
  const paths: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = readLedgerFile(join(dir, name));
    if (file === undefined) continue;
    // Pending or identified, whatever the owner's state: a staging guard has no
    // business deciding whether the process that recorded the path still lives.
    for (const entry of file.entries) paths.push(entry.path);
  }
  return paths;
}

/**
 * The placeholder-shaped paths under `cwd` that a staging pass must exclude, as
 * paths relative to `cwd`, deduplicated and in a stable order.
 *
 * `trackedPaths` are the paths git reported as already in the index — for
 * `gitlinkSafeAdd`, exactly what its own `ls-files --stage` call printed.
 */
export function stagingPlaceholderPaths(cwd: string, trackedPaths: readonly string[]): string[] {
  const base = resolve(cwd);
  const tracked = new Set(trackedPaths);
  const out: string[] = [];
  const seen = new Set<string>();
  const sources = [...SRT_MANDATORY_DENY_FILES.map((name) => join(base, name)), ...ledgerEntryPaths()];

  for (const path of sources) {
    if (!inside(base, path)) continue;
    // `placeholderIdentity` is `lstat`-based, so a source that no longer exists —
    // or an ancestor this process may not search — is not returned.
    const identity = placeholderIdentity(path);
    if (identity?.kind !== "file") continue;
    const rel = relative(base, path);
    if (rel === "" || tracked.has(rel) || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}
