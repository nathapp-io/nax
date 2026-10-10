/**
 * A1 advisor prompt (spec §4.4). The advisor rules on one judgment call per turn and replies with one
 * fenced JSON object. The policy text below is distilled from recorded human rulings — keep it in sync
 * with spec §4.4 when either changes.
 */
import type { AdviceDecision, AdviceQuestion } from "@/advisor/types";

export interface AdvisorPromptInput {
  readonly question: AdviceQuestion;
  readonly specPath: string;
  readonly prdText: string;
  readonly priorDecisions: readonly AdviceDecision[];
  /** True on a warm session's later turns: the role, policy, spec and PRD were already sent. */
  readonly continuation: boolean;
}

const ROLE = [
  "You are the advisor for an automated feature build. You know the whole feature: its spec, every story",
  "and acceptance criterion (AC), and every decision already made. A step in the build has stopped on a",
  "judgment call. You rule on it so the build can continue. You may read any file in the repository; you",
  "cannot change anything — nax applies your ruling.",
].join(" ");

const POLICY = `## Decision policy
1. Real defects get fixed, with the most conservative option (keep old data until new data is committed, take the same lock, count the real work done).
2. The spec wins unless its premise is wrong. If the code drifted from the spec, the code follows the spec.
3. Waive only with a spec-backed or scope-backed reason (e.g. "US-005 owns this"). When the spec itself is wrong and the code is right, choose supersede and give the corrected text.
4. A review that did not read the whole diff is never an approval.
5. Prefer reversible choices. Set needsHumanConfirm when you are unsure or the choice is hard to undo.
6. Verify claims by reading the code before you rule. Do not trust a finding's description on its own.`;

function decisionsBlock(decisions: readonly AdviceDecision[]): string {
  if (decisions.length === 0) return "## Decisions so far\nNone.";
  const lines = decisions.map(
    (d) => `- ${d.id} [${d.kind}${d.storyId ? ` ${d.storyId}` : ""}] ${d.action.type}: ${d.rationale}`,
  );
  return `## Decisions so far (stay consistent with these)\n${lines.join("\n")}`;
}

function questionBlock(q: AdviceQuestion): string {
  const evidence = q.evidence.map((e) => `- (${e.source}${e.ref ? ` ${e.ref}` : ""}) ${e.text}`).join("\n");
  const menu = q.options.map((o) => `${o.id}. [${o.type}] ${o.label}`).join("\n");
  return [
    `## Question ${q.id} (${q.kind}${q.storyId ? `, story ${q.storyId}` : ""})`,
    q.summary,
    `### Evidence\n${evidence}`,
    `### Options — choose exactly one\n${menu}`,
  ].join("\n\n");
}

const CONTRACT = `## Reply
End your reply with exactly one fenced JSON block:
\`\`\`json
{"optionId": "A", "instruction": "...", "reason": "...", "newText": "...", "rationale": "...", "confidence": "high|medium|low", "reversible": true, "needsHumanConfirm": false}
\`\`\`
Include "instruction" for fix/retry/retarget, "reason" for waive/escalate-tier/defer/hold, "newText" for supersede. "rationale" is always required.`;

export function buildAdvisorPrompt(input: AdvisorPromptInput): string {
  if (input.continuation) return [questionBlock(input.question), CONTRACT].join("\n\n");
  return [
    ROLE,
    POLICY,
    `## Feature\nSpec: ${input.specPath} (read it as needed)\n\nPRD:\n${input.prdText}`,
    decisionsBlock(input.priorDecisions),
    questionBlock(input.question),
    CONTRACT,
  ].join("\n\n");
}
