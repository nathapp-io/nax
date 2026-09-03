/**
 * Stage-and-commit, the one mutating git operation the implementer role needs.
 *
 * Separate from gitTool because buildGitArgv cannot express it: that builder
 * terminates with `--` and pathspecs and refuses any element beginning with
 * "-", so `commit -m <message>` is not representable in it. Splitting the tool
 * also lets a stage be granted the read verbs without the write one.
 *
 * The message is an argv ELEMENT, never parsed. A message that looks like a
 * flag is inert because it sits after `-m` in an argv array that never reaches
 * a shell -- a test pins that position.
 */
import { gitWithTimeout } from "@/utils/git";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

export function buildCommitArgvs(
  input: Record<string, unknown>,
): { add: string[]; commit: string[] } | { error: string } {
  const message = input.message;
  if (typeof message !== "string" || message.trim() === "") {
    return { error: "message must be a non-empty string" };
  }
  const paths = Array.isArray(input.paths) ? input.paths : [];
  if (paths.length === 0) return { error: "paths must name at least one file" };

  const add: string[] = ["add", "--"];
  for (const path of paths) {
    if (typeof path !== "string") return { error: "paths must be strings" };
    if (path.startsWith("-")) return { error: `path "${path}" may not begin with "-"` };
    add.push(path);
  }
  return { add, commit: ["commit", "-m", message] };
}

export const gitCommitTool: CodingTool = {
  name: "GitCommit",
  description:
    "Stage the named files and commit them. Supply the message as text and the files as an array; this is not a command line.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message. May contain a blank line and a body." },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Files to stage, relative to the repository root",
      },
    },
    required: ["message", "paths"],
  },
  scope: { pathFields: [], arrayPathFields: ["paths"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const built = buildCommitArgvs(input);
    if ("error" in built) return { content: built.error, isError: true };

    const staged = await gitWithTimeout(built.add, ctx.root, 30_000);
    if (staged.exitCode !== 0) {
      return { content: `git add failed: ${staged.stderr.trim() || `exit ${staged.exitCode}`}`, isError: true };
    }
    const committed = await gitWithTimeout(built.commit, ctx.root, 30_000);
    if (committed.exitCode !== 0) {
      return {
        content: `git commit failed: ${committed.stderr.trim() || `exit ${committed.exitCode}`}`,
        isError: true,
      };
    }
    return { content: committed.stdout.trim().slice(0, ctx.maxBytes) };
  },
};
