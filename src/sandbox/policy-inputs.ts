/**
 * The I/O half of the sandbox policy: what exists on disk right now.
 * Kept apart from policy-builder.ts so the builder stays pure.
 */
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { featuresDir, globalConfigDir } from "../config/paths";
import { gitWithTimeout } from "../utils/git";
import { realOrRaw } from "../utils/realpath";

export type GitLayout =
  | { readonly kind: "none" }
  | { readonly kind: "main"; readonly gitDir: string }
  | { readonly kind: "worktree"; readonly gitDir: string; readonly commonDir: string };

const GIT_LAYOUT_TIMEOUT_MS = 10_000;

export const _policyInputDeps = {
  git: (args: string[], cwd: string) => gitWithTimeout(args, cwd, GIT_LAYOUT_TIMEOUT_MS),
  readdir,
  homedir,
  tmpdir,
  platform: (): NodeJS.Platform => process.platform,
};

async function gitPath(flag: string, root: string): Promise<string | undefined> {
  const r = await _policyInputDeps.git(["rev-parse", flag], root);
  if (r.exitCode !== 0) return undefined;
  const out = r.stdout.trim();
  return realOrRaw(isAbsolute(out) ? out : resolve(root, out));
}

/** Resolved once per session. A worktree's git dir differs from its common dir. */
export async function resolveGitLayout(root: string): Promise<GitLayout> {
  const gitDir = await gitPath("--git-dir", root);
  const commonDir = await gitPath("--git-common-dir", root);
  if (gitDir === undefined || commonDir === undefined) return { kind: "none" };
  return gitDir === commonDir ? { kind: "main", gitDir } : { kind: "worktree", gitDir, commonDir };
}

/** One `<features>/<f>/prd.json` per feature directory present now (existing file or not). */
export async function listFeaturePrdPaths(root: string): Promise<string[]> {
  const dir = featuresDir(root);
  try {
    const entries = await _policyInputDeps.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name, "prd.json"));
  } catch {
    return [];
  }
}

/** Every `credentials*` file in the global nax dir, expanded to literals (F1: no globs). */
export async function listCredentialFiles(): Promise<string[]> {
  const dir = globalConfigDir();
  try {
    const entries = await _policyInputDeps.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.name.startsWith("credentials")).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** `os.tmpdir()` plus `/tmp` (Linux tools fall back to it; srt sets no TMPDIR there -- spec F3). */
export function defaultTempRoots(): string[] {
  return [_policyInputDeps.tmpdir(), "/tmp"];
}
