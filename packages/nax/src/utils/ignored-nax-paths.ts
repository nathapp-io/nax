/**
 * The nax-tracked paths a broad `.gitignore` rule hides (nax#2534).
 *
 * git never reports an ignored file: `git add` skips it silently and `git status`
 * says nothing, so a `.gitignore` written before the advisor ledger existed, or
 * one that ignores each whole feature directory, makes the PR ship without the
 * rulings its body cites. The only signal was a single warn line, and only when a
 * commit was attempted.
 *
 * This module is the one place that asks git which of the feature tree's
 * committed files a rule currently hides. One probe feature id is enough: the
 * paths are matched against the rules, not against the filesystem, so the
 * feature directory need not exist — and a broad rule hides every feature's copy
 * the same way. Consumers: `checkGitignoreCoversNax` (precheck) and `nax init`.
 */
import { relative } from "node:path";
import { gitWithTimeout } from "@nathapp/nax-agent/internal";
import { ledgerPath } from "@/advisor";
import { featureDir } from "@/config";

/**
 * The feature id the probe paths are built for. Any valid id matches the same
 * rules; a shape that cannot collide with a real feature (`_unattached` is the
 * established sentinel spelling) keeps the paths benign in a log line.
 */
const PROBE_FEATURE = "_probe";

/** Committed files beside the ledger — the feature's spec and its story list. */
const COMMITTED_FEATURE_FILES = ["spec.md", "prd.json"] as const;

export interface IgnoredNaxPath {
  /** Repo-relative path (POSIX separators), as git reported it. */
  readonly path: string;
  /** `<source>:<line>:<pattern>` — the ignore file, line and pattern that hide it. */
  readonly rule: string;
}

/**
 * Test seam for the one git call this module makes. Same return shape as
 * `_workflowDeps.git`, so a test drives the parser and the failure arm without a
 * repository.
 */
export const _ignoredNaxPathsDeps = {
  git: async (args: string[], cwd: string): Promise<{ stdout: string; stderr?: string; exitCode: number }> => {
    const { stdout, stderr, exitCode } = await gitWithTimeout(args, cwd);
    return { stdout, stderr, exitCode };
  },
};

/** The repo-relative candidate paths one `check-ignore` call asks about. */
function naxTrackedPaths(projectDir: string): string[] {
  const dir = featureDir(projectDir, PROBE_FEATURE);
  return [ledgerPath(projectDir, PROBE_FEATURE), ...COMMITTED_FEATURE_FILES.map((name) => `${dir}/${name}`)].map(
    (absolute) => relative(projectDir, absolute),
  );
}

/**
 * One `check-ignore -v` line: `<source>:<line>:<pattern><TAB><path>`. The source
 * is matched lazily so a pattern may itself contain a colon; the pattern is
 * everything between the line number and the TAB.
 */
const CHECK_IGNORE_LINE = /^(.*?):(\d+):(.*)\t(.*)$/;

/**
 * The paths a rule hides, one entry per match. A negated pattern (`!p`) means the
 * path is re-included, so it is not hidden and is left out.
 */
function parseCheckIgnore(stdout: string): IgnoredNaxPath[] {
  const out: IgnoredNaxPath[] = [];
  for (const raw of stdout.split("\n")) {
    const match = CHECK_IGNORE_LINE.exec(raw);
    if (!match) continue;
    const [, source, line, pattern, path] = match;
    if (path === "" || pattern.startsWith("!")) continue;
    out.push({ path, rule: `${source}:${line}:${pattern}` });
  }
  return out;
}

/**
 * Ask git which of the feature tree's committed paths a `.gitignore` currently
 * hides. `--no-index` is required: without it git reports nothing for a path that
 * is already in the index, which is exactly the ledger a run just added.
 *
 * git exits 0 with one line per hidden path, 1 when nothing is hidden, and
 * anything else when the question cannot be asked at all (not a repository).
 * Both the last case and a failed spawn report nothing — a precheck and an init
 * must not turn "git could not answer" into a scary warning.
 */
export async function findIgnoredNaxTrackedPaths(projectDir: string): Promise<IgnoredNaxPath[]> {
  let result: { stdout: string; exitCode: number };
  try {
    result = await _ignoredNaxPathsDeps.git(
      ["check-ignore", "-v", "--no-index", "--", ...naxTrackedPaths(projectDir)],
      projectDir,
    );
  } catch {
    return [];
  }
  if (result.exitCode !== 0) return [];
  return parseCheckIgnore(result.stdout);
}

/**
 * `path` with its feature-id segment replaced by `*`, so one rule covers every
 * feature — a rule naming the probe would be useless to the reader. `keepFile`
 * picks the file's own re-include line; dropping it names the directory instead.
 */
function widenFeatureSegment(path: string, keepFile: boolean): string {
  const segments = path.split("/");
  if (segments.length < 2) return path;
  segments[segments.length - 2] = "*";
  return (keepFile ? segments : segments.slice(0, -1)).join("/");
}

/**
 * One user-facing line per hidden path: what is hidden, which rule hides it, and
 * the two ways out. Shared by the precheck failure and `nax init`'s warning so the
 * two never drift apart.
 *
 * The second fix matters: a negation cannot re-include a path whose *directory*
 * is ignored, which is the whole-feature-directory case — there the rule itself
 * has to go.
 */
export function ignoredNaxPathMessage(entry: IgnoredNaxPath): string {
  const directory = widenFeatureSegment(entry.path, false);
  return (
    `git ignores the nax-tracked file ${entry.path}, so it will not be committed (rule ${entry.rule}). ` +
    `Add "!${widenFeatureSegment(entry.path, true)}" to .gitignore, or replace the wholesale "${directory}/" rule: ` +
    "a negation cannot re-include a path under an ignored directory."
  );
}
