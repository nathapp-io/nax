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

/** Read-only verbs. Mutating verbs are not representable in the input type. */
export const GIT_READ_VERBS: readonly string[] = ["diff", "log", "show", "status", "blame"];

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
  for (const ref of refs) {
    if (typeof ref !== "string") return { error: "refs must be strings" };
    // A ref that begins with "-" would be parsed as an option, which is how an
    // escape flag would arrive. Refuse rather than sanitise.
    if (looksLikeFlag(ref)) return { error: `ref "${ref}" may not begin with "-"` };
    argv.push(ref);
  }

  if (paths.length > 0) {
    argv.push("--");
    for (const path of paths) {
      if (typeof path !== "string") return { error: "paths must be strings" };
      if (looksLikeFlag(path)) return { error: `path "${path}" may not begin with "-"` };
      argv.push(path);
    }
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
    "Run a read-only git command (diff, log, show, status, blame) in the repository. Supply refs and pathspecs as arrays, not as a command line.",
  inputSchema: {
    type: "object",
    properties: {
      subcommand: { type: "string", enum: [...GIT_READ_VERBS], description: "Read-only git subcommand" },
      refs: { type: "array", items: { type: "string" }, description: "Refs, e.g. ['HEAD~1','HEAD']" },
      paths: { type: "array", items: { type: "string" }, description: "Pathspecs, relative to the repository root" },
    },
    required: ["subcommand"],
  },
  scope: { pathFields: [], verbField: "subcommand", allowedVerbs: GIT_READ_VERBS },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const built = buildGitArgv(input);
    if ("error" in built) return { content: built.error, isError: true };

    try {
      const { stdout, stderr, exitCode } = await gitWithTimeout(built, ctx.root);
      if (exitCode !== 0 && stdout.trim() === "") {
        return { content: stderr.trim() || `git exited ${exitCode}`, isError: true };
      }
      return { content: truncate(stdout.trimEnd(), ctx.maxBytes) || "(no output)" };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
