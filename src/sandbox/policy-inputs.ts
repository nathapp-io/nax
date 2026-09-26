/**
 * The I/O half of the sandbox policy: what exists on disk right now.
 * Kept apart from policy-builder.ts so the builder stays pure.
 */
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { globalConfigDir, PROJECT_NAX_DIR } from "../config/paths";
import { SANDBOX_GLOB_CHARS } from "../config/schemas-sandbox";
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

/**
 * Top-level entry names under `<root>/.nax` right now (nax#2260). An entry
 * with a glob character is skipped: nax never creates one, and a glob in the
 * policy would make every build throw (F1) -- an agent could otherwise switch
 * the sandbox off by creating `.nax/a*b`.
 */
export async function listNaxEntries(root: string): Promise<string[]> {
  try {
    const names = await _policyInputDeps.readdir(join(root, PROJECT_NAX_DIR));
    return names.filter((name) => !SANDBOX_GLOB_CHARS.test(name));
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
