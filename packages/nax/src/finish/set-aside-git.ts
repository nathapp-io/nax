/**
 * Finish A §4: the git reads and path handling behind set-aside.
 *
 * Every path-taking call runs from the repository root with `--literal-pathspecs`,
 * and every listing is read NUL-separated, so a name with a space, non-ASCII bytes or
 * glob characters is one literal path. A listing that failed returns `null`: the
 * caller must not read that as "nothing changed".
 */
import { _finishGitDeps } from "./commit";

export const SET_ASIDE_GIT_MS = 30_000;
const CHUNK = 300;

/** Runs git with literal pathspecs. Argv-based; never a shell. */
export const gitLiteral = (args: string[], cwd: string) =>
  _finishGitDeps.git(["--literal-pathspecs", ...args], cwd, SET_ASIDE_GIT_MS);

const nul = (s: string): string[] => s.split("\0").filter((p) => p !== "");

export function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The repository root for `workdir` (falls back to `workdir` itself when it cannot be read). */
export async function repoRoot(workdir: string): Promise<string> {
  const res = await gitLiteral(["rev-parse", "--show-toplevel"], workdir);
  const top = res.exitCode === 0 ? res.stdout.replace(/\r?\n$/, "") : "";
  return top === "" ? workdir : top;
}

/** Untracked, non-ignored paths (repo-root relative), or null when git failed. */
export async function listUntracked(root: string): Promise<string[] | null> {
  const res = await gitLiteral(["status", "--porcelain=v1", "-z", "-uall"], root);
  if (res.exitCode !== 0) return null;
  const out: string[] = [];
  const tokens = res.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    if (t.startsWith("?? ")) out.push(t.slice(3));
    else if (t[0] === "R" || t[0] === "C" || t[1] === "R" || t[1] === "C") i++; // a rename/copy entry is followed by its source path
  }
  return out;
}

/** Paths that differ from `baseSha` (renames split into delete + add), or null when git failed. */
export async function listChanged(root: string, baseSha: string): Promise<string[] | null> {
  const res = await gitLiteral(["diff", "--name-only", "--no-renames", "-z", baseSha], root);
  return res.exitCode === 0 ? nul(res.stdout) : null;
}

/** Every path in `baseSha`'s tree, or null when git failed. */
export async function listBaseTree(root: string, baseSha: string): Promise<Set<string> | null> {
  const res = await gitLiteral(["ls-tree", "-r", "--name-only", "-z", baseSha], root);
  return res.exitCode === 0 ? new Set(nul(res.stdout)) : null;
}

/** `path\t...` numstat entries from `git apply --numstat -z`. */
export function numstatPaths(stdout: string): string[] {
  return nul(stdout)
    .map((entry) => entry.split("\t")[2] ?? "")
    .filter(Boolean);
}
