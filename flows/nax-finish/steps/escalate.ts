import { NaxError } from "@/errors";
import type { Finding, RunFn } from "../types";

/** Matches the first http(s) URL on a line — `gh`/`glab` print the URL on stdout. */
const URL_REGEX = /https?:\/\/\S+/;

async function defaultRun(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export const _escalateDeps: { run: RunFn } = { run: defaultRun };

export function buildEscalationComment(feature: string, escalationReason: string, findings: Finding[]): string {
  const lines = [
    `## nax-finish escalation — \`${feature}\``,
    "",
    "This feature needs human judgment before it can ship. nax-finish stopped rather than guess.",
    "",
    `**Needs judgment:** ${escalationReason}`,
    "",
    "### Findings",
    ...findings.map((f) => `- **[${f.severity}] ${f.title}** — ${f.problem}\n  - Suggested: ${f.fix}`),
  ];
  return lines.join("\n");
}

async function detectForge(repoRoot: string, stage: string): Promise<"github" | "gitlab"> {
  const remote = await _escalateDeps.run(["git", "remote", "get-url", "origin"], { cwd: repoRoot });
  const remoteUrl = remote.stdout.trim();
  if (remoteUrl.includes("github.com")) return "github";
  if (remoteUrl.includes("gitlab.com")) return "gitlab";
  throw new NaxError(`Unable to determine forge from remote URL "${remoteUrl}"`, "FINISH_UNKNOWN_FORGE", {
    stage,
    remoteUrl,
  });
}

export async function postEscalation(repoRoot: string, branch: string, comment: string): Promise<{ url?: string }> {
  const forge = await detectForge(repoRoot, "finish-escalate");

  const viewCmd =
    forge === "github"
      ? ["gh", "pr", "view", branch, "--json", "url"]
      : ["glab", "mr", "view", branch, "--output", "json"];
  const view = await _escalateDeps.run(viewCmd, { cwd: repoRoot });

  if (view.exitCode === 0) {
    const commentCmd =
      forge === "github"
        ? ["gh", "pr", "comment", branch, "--body", comment]
        : ["glab", "mr", "note", branch, "--message", comment];
    await _escalateDeps.run(commentCmd, { cwd: repoRoot });
    return { url: extractUrl(view.stdout) };
  }

  const createCmd =
    forge === "github"
      ? ["gh", "pr", "create", "--draft", "--title", `nax-finish: ${branch}`, "--body", comment, "--head", branch]
      : [
          "glab",
          "mr",
          "create",
          "--draft",
          "--title",
          `nax-finish: ${branch}`,
          "--description",
          comment,
          "--source-branch",
          branch,
        ];
  const create = await _escalateDeps.run(createCmd, { cwd: repoRoot });
  return { url: extractUrl(create.stdout) };
}

/** Best-effort URL extraction: try `{url}` JSON first, fall back to a raw URL regex on stdout. */
function extractUrl(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { url?: string };
    if (parsed.url) return parsed.url;
  } catch {
    // fall through to regex extraction
  }
  const match = stdout.match(URL_REGEX);
  return match ? match[0] : undefined;
}
