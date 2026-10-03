/**
 * The I/O half of the sandbox policy: what exists on disk right now.
 * Kept apart from policy-builder.ts so the builder stays pure.
 */
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { gitWithTimeout } from "#src/internal/git-exec";
import { realOrRaw } from "#src/internal/realpath";
import { SANDBOX_GLOB_CHARS } from "../config/schemas-sandbox.ts";

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
 * Top-level entry names under `<root>/<stateDir>` right now (nax#2260;
 * `stateDir` is `.nax` for nax). An entry with a glob character is skipped:
 * nax never creates one, and a glob in the policy would make every build
 * throw (F1) -- an agent could otherwise switch the sandbox off by creating
 * `.nax/a*b`.
 */
export async function listNaxEntries(root: string, stateDir: string): Promise<string[]> {
  try {
    const names = await _policyInputDeps.readdir(join(root, stateDir));
    return names.filter((name) => !SANDBOX_GLOB_CHARS.test(name));
  } catch {
    return [];
  }
}

/** Every `credentials*` file in `dir` (the host's credential dir), expanded to literals (F1: no globs). */
export async function listCredentialFiles(dir: string): Promise<string[]> {
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

/** The shared temp root under both spellings: `/tmp`, and its macOS realpath. */
const SHARED_TMP_ROOTS = ["/tmp", "/private/tmp"];

/**
 * US-002: the temp roots a CONFINED session gets -- the run's own root, plus
 * the host tmpdir only when that is not the shared one. `os.tmpdir()` is
 * `/tmp` on most Linux hosts and keeping it would re-grant exactly the shared
 * directory the confinement exists to remove; a tmpdir of `/private/tmp` is
 * the same directory seen through macOS's symlink.
 */
export function runTempRoots(opts: { runTmpRoot: string; tmpdir: string }): string[] {
  const shared = SHARED_TMP_ROOTS.some((root) => opts.tmpdir === root || opts.tmpdir.startsWith(`${root}/`));
  return shared ? [opts.runTmpRoot] : [opts.tmpdir, opts.runTmpRoot];
}
