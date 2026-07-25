import { FinishError } from "../errors";
import { runArgv } from "../exec";
import type { Finding, RunFn } from "../types";
import { detectForge, extractUrl, viewArgv } from "./forge";

export const _escalateDeps: { run: RunFn } = { run: runArgv };

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

export interface EscalationOutcome {
  url?: string;
  /** Where the "needs judgment" message was delivered. */
  channel: "telegram" | "pr-comment";
}

/**
 * Deliver an escalation.
 *
 * `preferTelegram` (set by the plugin only when Telegram is both enabled and
 * credentialed) makes Telegram the sole channel: the flow posts no comment and
 * — critically — opens no draft PR to hold one, matching the design's
 * "prefer Telegram when configured, else fall back to a PR/MR comment". The
 * plugin sends the message itself after reading the result file. It still reads
 * any existing PR/MR so the notification can carry a link, which is a read-only
 * lookup with no side effect.
 */
export async function postEscalation(
  repoRoot: string,
  branch: string,
  comment: string,
  opts: { preferTelegram?: boolean } = {},
): Promise<EscalationOutcome> {
  const forge = await detectForge(_escalateDeps.run, repoRoot, "finish-escalate");
  const view = await _escalateDeps.run(viewArgv(forge, branch, "url"), { cwd: repoRoot });
  const existingUrl = view.exitCode === 0 ? extractUrl(view.stdout) : undefined;

  if (opts.preferTelegram) {
    return { url: existingUrl, channel: "telegram" };
  }

  if (view.exitCode === 0) {
    const commentCmd =
      forge === "github"
        ? ["gh", "pr", "comment", branch, "--body", comment]
        : ["glab", "mr", "note", branch, "--message", comment];
    const commented = await _escalateDeps.run(commentCmd, { cwd: repoRoot });
    if (commented.exitCode !== 0) {
      throw new FinishError(
        `Failed to post escalation comment on "${branch}": ${commented.stderr.trim() || `exit ${commented.exitCode}`}`,
        "FINISH_ESCALATION_COMMENT_FAILED",
        { stage: "finish-escalate", branch },
      );
    }
    return { url: existingUrl, channel: "pr-comment" };
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
  if (create.exitCode !== 0) {
    throw new FinishError(
      `Failed to open a draft to hold the escalation for "${branch}": ${create.stderr.trim() || `exit ${create.exitCode}`}`,
      "FINISH_ESCALATION_DRAFT_FAILED",
      { stage: "finish-escalate", branch },
    );
  }
  return { url: extractUrl(create.stdout), channel: "pr-comment" };
}
