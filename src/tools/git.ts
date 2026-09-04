/**
 * Read-only git, for reviewers that need a real diff rather than one pushed
 * into the prompt.
 *
 * This spawns a subprocess, which ADR-029 section 3 severed for Bash. The
 * distinction, written down rather than assumed: git is a FIXED binary invoked
 * with an argv nax constructs entirely, with no shell. The model supplies
 * structure — a subcommand, refs, pathspecs — never a command string. Bash
 * inverts that, which is why it needs a sandbox and a threat model instead of
 * an allowlist.
 *
 * Reuses gitWithTimeout, which already provides the argv-array spawn, the
 * explicit cwd, the SIGKILL timeout, and concurrent pipe draining — the last of
 * which matters here because `git log -p` is exactly the output that fills a
 * 64KB pipe buffer and deadlocks a naive implementation.
 */

import { gitWithTimeout } from "@/utils/git";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

/**
 * Read-only verbs. Mutating verbs are not representable in the input type.
 *
 * Note what bounds these: the argv shape below, not the verb list. A read-only
 * verb still spans the whole repository unless its scope is stated.
 */
export const GIT_READ_VERBS: readonly string[] = ["diff", "log", "show", "status", "blame"];

/**
 * Verbs whose output prints "a/<path>"/"b/<path>" diff headers, which git
 * always frames relative to the repository top-level regardless of cwd
 * (confirmed independently by the porcelain-path comment in
 * `src/utils/git.ts`'s `autoCommitIfDirty`). Read/Grep/Glob resolve a path
 * relative to the permitted root (`ctx.root`), so when that root is a package
 * subdir the two frames diverge -- issue #1807.
 *
 * `--relative` (with no argument, so relative to cwd) makes git itself apply
 * that offset before it quotes a path, rather than after -- so it also
 * handles a non-ASCII path (which git quotes and octal-escapes, wrapping the
 * "a/" prefix) and a path containing a space (which a whitespace-delimited
 * regex can't span, and after which git appends a trailing tab). `status`
 * rejects the flag outright; `blame` never emits these headers, so neither
 * needs it.
 */
const GIT_RELATIVE_VERBS: readonly string[] = ["diff", "log", "show"];

/**
 * Typed flag fields, and the verbs each one is valid on.
 *
 * nax emits every one of these flags itself: a boolean or a closed enum comes
 * in, a fixed string goes out. The model never supplies flag text, so the
 * property the header comment defends — the model supplies structure, nax
 * constructs the argv — is unchanged by their existence. That is the whole
 * reason they are typed fields rather than a passthrough list.
 *
 * They exist because `git diff --name-only --diff-filter=A` is step 1 of the
 * adversarial reviewer's test-audit workflow and was not expressible at all:
 * the only way to ask for it was to put the flags in `refs`/`paths`, where
 * `looksLikeFlag` refuses them (#1818). A field is gated to the verbs it
 * applies to so a wrong pairing is a nax error the model can act on, rather
 * than a git usage error it has to interpret.
 */
export const GIT_DIFF_FILTERS: readonly string[] = ["A", "M", "D", "R"];
// `show` is deliberately absent: git itself refuses it — "options '--name-only',
// '--name-status', '--check', and '-s' cannot be used together" (git 2.50.1),
// because `show` already supplies a conflicting output selector. Verified by
// running it; a nax-side refusal here is the clearer of the two errors.
const GIT_NAME_ONLY_VERBS: readonly string[] = ["diff", "log"];
const GIT_DIFF_FILTER_VERBS: readonly string[] = ["diff", "log"];
const GIT_ONELINE_VERBS: readonly string[] = ["log"];

/**
 * A boolean flag field: absent or `false` emits nothing, `true` emits the flag.
 *
 * A non-boolean is refused rather than coerced — `nameOnly: "false"` is truthy
 * in JavaScript, so coercion would turn a model's mistake into the opposite of
 * what it asked for.
 */
function flagFromBoolean(
  input: Record<string, unknown>,
  field: string,
  subcommand: string,
  validVerbs: readonly string[],
  flag: string,
): string | null | { error: string } {
  const value = input[field];
  if (value === undefined) return null;
  if (typeof value !== "boolean") return { error: `"${field}" must be a boolean` };
  // Checked before the verb gate: `false` asks for nothing, so refusing it for
  // the wrong verb would invent a refusal — the failure class this change
  // exists to reduce.
  if (!value) return null;
  if (!validVerbs.includes(subcommand)) {
    return { error: `"${field}" is not valid for "${subcommand}" (valid for: ${validVerbs.join(", ")})` };
  }
  return flag;
}

/**
 * Flags that escape the repository or execute code.
 *
 * `-c` is included because config injection is a command-execution vector:
 * `-c core.pager=<cmd>` runs <cmd>. These are never emitted, and a test asserts
 * their absence from every built argv so a later refactor cannot reintroduce
 * one silently.
 */
export const GIT_ESCAPE_FLAGS: readonly string[] = ["-C", "--git-dir", "--work-tree", "--exec-path", "-c"];

function looksLikeFlag(value: string): boolean {
  return value.startsWith("-");
}

export function buildGitArgv(input: Record<string, unknown>): string[] | { error: string } {
  const subcommand = input.subcommand;
  if (typeof subcommand !== "string" || !GIT_READ_VERBS.includes(subcommand)) {
    return { error: `subcommand must be one of: ${GIT_READ_VERBS.join(", ")}` };
  }

  const refs = Array.isArray(input.refs) ? input.refs : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];

  const argv: string[] = [subcommand];
  if (GIT_RELATIVE_VERBS.includes(subcommand)) argv.push("--relative");

  // Flags precede the refs. Git accepts them in either position, but a flag
  // placed after a revision list reads as a pathspec to anyone (model or
  // human) scanning the argv, and this argv is written into the tool-audit
  // ledger that #1818 was filed from.
  const nameOnly = flagFromBoolean(input, "nameOnly", subcommand, GIT_NAME_ONLY_VERBS, "--name-only");
  if (nameOnly !== null && typeof nameOnly === "object") return nameOnly;
  if (nameOnly !== null) argv.push(nameOnly);

  const diffFilter = input.diffFilter;
  if (diffFilter !== undefined) {
    if (typeof diffFilter !== "string" || !GIT_DIFF_FILTERS.includes(diffFilter)) {
      return { error: `"diffFilter" must be one of: ${GIT_DIFF_FILTERS.join(", ")}` };
    }
    if (!GIT_DIFF_FILTER_VERBS.includes(subcommand)) {
      return {
        error: `"diffFilter" is not valid for "${subcommand}" (valid for: ${GIT_DIFF_FILTER_VERBS.join(", ")})`,
      };
    }
    argv.push(`--diff-filter=${diffFilter}`);
  }

  const oneline = flagFromBoolean(input, "oneline", subcommand, GIT_ONELINE_VERBS, "--oneline");
  if (oneline !== null && typeof oneline === "object") return oneline;
  if (oneline !== null) argv.push(oneline);

  for (const ref of refs) {
    if (typeof ref !== "string") return { error: "refs must be strings" };
    // A ref that begins with "-" would be parsed as an option, which is how an
    // escape flag would arrive. Refuse rather than sanitise.
    if (looksLikeFlag(ref)) return { error: `ref "${ref}" may not begin with "-"` };
    argv.push(ref);
  }

  // `--` ALWAYS terminates the revision list, even with no paths to follow it.
  // Without it git disambiguates an argument that is not a valid revision by
  // checking whether it names a path, and silently reinterprets it as a
  // pathspec -- so `show ../../outside/secret` read a file outside the root,
  // never reaching resolveWithin because a colon-less ref was treated as "a
  // pure revision, nothing to contain". With `--` git rejects it outright.
  argv.push("--");

  if (paths.length === 0) {
    // Scope an unrestricted call to the root. A ref names a whole commit, whose
    // diff spans the entire repository, so `show HEAD` returned outside-root
    // content without naming a path at all -- nothing in the argv was wrong,
    // the command's own scope was. `.` is resolved by git against the cwd,
    // which gitWithTimeout sets to the permitted root.
    argv.push(".");
    return argv;
  }

  for (const path of paths) {
    if (typeof path !== "string") return { error: "paths must be strings" };
    if (looksLikeFlag(path)) return { error: `path "${path}" may not begin with "-"` };
    argv.push(path);
  }

  return argv;
}

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

export const gitTool: CodingTool = {
  name: "Git",
  description:
    "Run a read-only git command (diff, log, show, status, blame) in the repository. Supply refs and pathspecs as arrays, not as a command line. Command-line flags are not accepted in any field; use the nameOnly, diffFilter and oneline fields instead.",
  inputSchema: {
    type: "object",
    properties: {
      subcommand: { type: "string", enum: [...GIT_READ_VERBS], description: "Read-only git subcommand" },
      refs: { type: "array", items: { type: "string" }, description: "Refs, e.g. ['HEAD~1','HEAD']" },
      paths: { type: "array", items: { type: "string" }, description: "Pathspecs, relative to the permitted root" },
      nameOnly: { type: "boolean", description: "List file names only, no content (diff, log)" },
      diffFilter: {
        type: "string",
        enum: [...GIT_DIFF_FILTERS],
        description: "Select only files Added (A), Modified (M), Deleted (D) or Renamed (R) (diff)",
      },
      oneline: { type: "boolean", description: "One line per commit (log)" },
    },
    required: ["subcommand"],
  },
  // `paths` entries and the path-portion of `refs` entries (git's
  // "<rev>:<path>" syntax) are checked for containment via arrayPathFields /
  // refPathFields — see the ToolScope doc comment for why they carry no
  // pattern matching. The verb gate above is still what bounds which git
  // subcommands may run at all.
  scope: {
    pathFields: [],
    arrayPathFields: ["paths"],
    refPathFields: ["refs"],
    verbField: "subcommand",
    allowedVerbs: GIT_READ_VERBS,
  },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const built = buildGitArgv(input);
    if ("error" in built) return { content: built.error, isError: true };

    try {
      const { stdout, stderr, exitCode } = await gitWithTimeout(built, ctx.root, undefined, ctx.maxBytes);
      if (exitCode !== 0 && stdout.trim() === "") {
        return { content: stderr.trim() || `git exited ${exitCode}`, isError: true };
      }
      return { content: truncate(stdout.trimEnd(), ctx.maxBytes) || "(no output)" };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
