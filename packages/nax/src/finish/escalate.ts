/**
 * Delivering an escalation to its channel: a comment on the existing PR/MR, or
 * a draft opened to hold it, or nothing at all when Telegram is preferred.
 *
 * Ported from `flows/nax-finish/steps/escalate.ts` (read-only reference, never
 * imported). Restructured so the forge is a required argument rather than
 * detected inside, and so I/O arrives as `ForgeDeps` rather than a
 * module-level `_escalateDeps` seam. The comment text is byte-identical to the
 * flow's — it is what a human reads and there is no reason for the two to
 * differ.
 */
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeKind } from "@/forge";
import { extractUrl, viewArgv } from "@/forge";
import type { Finding } from "./types";

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
 * `preferTelegram` (set by `runFinishPhase` in `phase.ts` only when Telegram is
 * both enabled and credentialed) makes Telegram the sole channel: the flow
 * posts no comment and — critically — opens no draft PR to hold one, matching
 * the design's "prefer Telegram when configured, else fall back to a PR/MR
 * comment". `runFinishPhase`'s own `notify()` helper sends the message itself
 * after the machine returns a result. It still reads any existing PR/MR so the
 * notification can carry a link, which is a read-only lookup with no side
 * effect.
 */
export async function postEscalation(
  args: { workdir: string; branch: string; comment: string; forge: ForgeKind; preferTelegram?: boolean },
  deps: ForgeDeps,
): Promise<EscalationOutcome> {
  const view = await deps.run(viewArgv(args.forge, args.branch, "url"), { cwd: args.workdir });
  const existingUrl = view.exitCode === 0 ? extractUrl(view.stdout) : undefined;

  if (args.preferTelegram) {
    return { url: existingUrl, channel: "telegram" };
  }

  if (view.exitCode === 0) {
    const commentCmd =
      args.forge === "github"
        ? ["gh", "pr", "comment", args.branch, "--body", args.comment]
        : ["glab", "mr", "note", args.branch, "--message", args.comment];
    const commented = await deps.run(commentCmd, { cwd: args.workdir });
    if (commented.exitCode !== 0) {
      throw new NaxError(
        `Failed to post escalation comment on "${args.branch}": ${commented.stderr.trim() || `exit ${commented.exitCode}`}`,
        "FINISH_ESCALATION_COMMENT_FAILED",
        { stage: "finish-escalate", branch: args.branch },
      );
    }
    return { url: existingUrl, channel: "pr-comment" };
  }

  const createCmd =
    args.forge === "github"
      ? [
          "gh",
          "pr",
          "create",
          "--draft",
          "--title",
          `nax-finish: ${args.branch}`,
          "--body",
          args.comment,
          "--head",
          args.branch,
        ]
      : [
          "glab",
          "mr",
          "create",
          "--draft",
          "--title",
          `nax-finish: ${args.branch}`,
          "--description",
          args.comment,
          "--source-branch",
          args.branch,
        ];
  const create = await deps.run(createCmd, { cwd: args.workdir });
  if (create.exitCode !== 0) {
    throw new NaxError(
      `Failed to open a draft to hold the escalation for "${args.branch}": ${create.stderr.trim() || `exit ${create.exitCode}`}`,
      "FINISH_ESCALATION_DRAFT_FAILED",
      { stage: "finish-escalate", branch: args.branch },
    );
  }
  return { url: extractUrl(create.stdout), channel: "pr-comment" };
}
