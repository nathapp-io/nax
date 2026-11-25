/**
 * #3038, Linux: the nested half of srt's mandatory write denies, beneath a root.
 *
 * Besides the names directly under the process cwd, srt's Linux backend denies the same
 * names at any depth beneath it, but ONLY those that exist: a single `rg --files` scan
 * (`linuxGetMandatoryDenyPaths`) runs against `process.cwd()` before every wrap, finds
 * the matches, and denies each one (or its directory). srt has no parameter to point
 * that scan elsewhere, so a session root that is not the cwd needs the same scan run
 * under the root, its matches turned into the same literal denies.
 *
 * Mirrored from `@anthropic-ai/sandbox-runtime` 0.0.77, on purpose and in full:
 *   - the arguments: `--files --hidden --max-depth 3`, one `--iglob` per name, the
 *     directory globs `**\/<dir>/**`, `**\/.git/hooks/**` and `**\/.git/config`, and
 *     `-g '!**\/node_modules/**'`, so ripgrep's own ignore handling applies as it does
 *     for srt, and the result is never stricter than cwd == root would be;
 *   - the mapping from a match to a deny path (`nestedDenyPaths`).
 *
 * Bounded: one spawn with a timeout. A scan that fails, times out or cannot spawn
 * returns no nested denies and warns; the top-level denies still hold and the command
 * is never failed. srt's own scan is skipped here when the cwd already is the root.
 */
import { resolve, sep } from "node:path";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { runArgv } from "#src/internal/argv-exec";
import { realOrRaw } from "#src/internal/realpath";
import { SANDBOX_GLOB_CHARS } from "../config/schemas-sandbox.ts";
import { SRT_MANDATORY_DENY_DIRS, SRT_MANDATORY_DENY_FILES } from "./defaults.ts";

/** srt's DEFAULT_MANDATORY_DENY_SEARCH_DEPTH. */
const SEARCH_DEPTH = 3;

/** srt gives its own scan 10 s; the same bound, so a slow tree costs no more than srt's scan already does. */
const SCAN_TIMEOUT_MS = 10_000;

export const _nestedDenyDeps = {
  run: runArgv,
  // biome-ignore lint/plugin: srt anchors its own scan at process.cwd(); whether this one is redundant depends on exactly that value. Tests override it.
  cwd: (): string => process.cwd(),
};

/** The dangerous directory names srt maps a match to, in its order, `.git` last. */
const DIRECTORY_NAMES: readonly string[] = [...SRT_MANDATORY_DENY_DIRS.filter((d) => !d.includes("/")), ".git"];

/** The rg command line of srt's scan, with `root` as the target. */
export function ripgrepScanArgs(root: string): string[] {
  const iglobs: string[] = [];
  for (const name of SRT_MANDATORY_DENY_FILES) iglobs.push("--iglob", name);
  for (const dir of SRT_MANDATORY_DENY_DIRS) iglobs.push("--iglob", `**/${dir}/**`);
  iglobs.push("--iglob", "**/.git/hooks/**", "--iglob", "**/.git/config");
  return [
    "rg",
    "--files",
    "--hidden",
    "--max-depth",
    String(SEARCH_DEPTH),
    ...iglobs,
    "-g",
    "!**/node_modules/**",
    root,
  ];
}

function insideRoot(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * srt's mapping from one match to the path it denies, applied to every match: a file
 * inside a dangerous directory denies that directory (for `.git`, its `hooks` or
 * `config`); any other match denies the file itself. Directory names are compared
 * case-folded, as srt does, and `.claude/commands` and `.claude/agents` -- whose names
 * hold a slash -- never match a path segment, so a match beneath them denies the FILE.
 *
 * Differences from srt, each only narrowing the result: names are looked for below the
 * root only (srt would map a dangerous name among the root's own segments to an
 * ancestor of the root), a path outside the root is dropped, and so is one holding a glob
 * character, which the literal-only policy would refuse (an agent could otherwise
 * disable the sandbox by creating `a*b/.mcp.json`).
 */
export function nestedDenyPaths(root: string, matches: readonly string[]): string[] {
  const out = new Set<string>();
  for (const match of matches) {
    const absolute = resolve(root, match);
    // Segments BELOW the root only: srt searches the whole path, so a dangerous name among
    // the root's own segments would send it to an ancestor of the root.
    const prefix = root.split(sep).length;
    const segments = absolute.split(sep);
    let denied = absolute;
    for (const dirName of DIRECTORY_NAMES) {
      const index = segments.findIndex((s, i) => i >= prefix && s.toLowerCase() === dirName.toLowerCase());
      if (index === -1) continue;
      const dir = segments.slice(0, index + 1).join(sep);
      if (dirName === ".git") {
        denied = match.includes(".git/hooks") ? `${dir}${sep}hooks` : `${dir}${sep}config`;
      } else {
        denied = dir;
      }
      break;
    }
    if (insideRoot(root, denied) && !SANDBOX_GLOB_CHARS.test(denied)) out.add(denied);
  }
  return [...out];
}

function warnFallback(root: string, reason: string): void {
  getSafeLogger()?.warn("sandbox", "nested mandatory-deny scan failed; only the top-level denies apply", {
    root,
    reason,
  });
}

/**
 * The existing nested mandatory names beneath `root` (Linux), as literal denies.
 * Empty when `root` is already the process cwd: srt runs this very scan there itself.
 */
export async function listNestedMandatoryDenies(root: string): Promise<string[]> {
  if (realOrRaw(_nestedDenyDeps.cwd()) === realOrRaw(root)) return [];
  try {
    const r = await _nestedDenyDeps.run({ argv: ripgrepScanArgs(root), cwd: root, timeoutMs: SCAN_TIMEOUT_MS });
    // ripgrep exits 1 for "no matches", which is the normal answer.
    if (r.exitCode === 1 && !r.timedOut) return [];
    if (r.timedOut || r.exitCode !== 0) {
      warnFallback(root, r.timedOut ? "timed out" : `exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)}`);
      return [];
    }
    return nestedDenyPaths(
      root,
      r.stdout.split("\n").filter((line) => line !== ""),
    );
  } catch (error) {
    warnFallback(root, errorMessage(error));
    return [];
  }
}
