/** The advisor question for one chain finding: the finding, the ledger's parents and git evidence (US-005). */
import { type AdviceEvidence, buildMenu, type QuestionDraft } from "@/advisor";
import type { ChainFinding } from "./chain-advise";
import { chainRulingKey } from "./chain-rulings";
import type { BotFixEnv } from "./fix-steps";
import { botGit } from "./git";
import { parentIssue } from "./push-ledger";
import { ownLedgerEntries } from "./push-record";

export const _chainQuestionDeps = { runGit: botGit };

/** A diff longer than this is cut, so one large file cannot crowd the advisor's prompt. */
export const CHAIN_DIFF_CHARS = 12_000;
const SHORT_SHA_LENGTH = 7;

type Finding = ChainFinding["item"];

function findingText(item: Finding): string {
  const where = item.file === undefined ? "(no file)" : `${item.file}${item.line === undefined ? "" : `:${item.line}`}`;
  const lines = [
    `Issue: ${item.issue}`,
    `Location: ${where}`,
    `Severity: ${item.severity}`,
    `Trigger: ${item.trigger ?? "unknown"}${item.triggerEvidence ? ` — ${item.triggerEvidence}` : ""}`,
    `Origin: ${item.origin ?? "pr"}${item.originEvidence ? ` — ${item.originEvidence}` : ""}`,
  ];
  if (item.suggestion !== undefined) lines.push(`Suggestion: ${item.suggestion}`);
  return lines.join("\n");
}

function reviewRoundText(env: BotFixEnv, item: Finding, pushSha: string, parents: readonly string[]): string {
  const entries = ownLedgerEntries(env.own);
  const lines = parents.map((key) => {
    const issue = parentIssue(pushSha, key, entries);
    return issue === undefined ? key : `${key}: ${issue}`;
  });
  return `Push ${pushSha} fixed these items, and ${item.key} sits on its lines:\n${lines.join("\n")}`;
}

async function gitEvidence(env: BotFixEnv, args: string[], ref: string): Promise<AdviceEvidence | undefined> {
  try {
    const result = await _chainQuestionDeps.runGit(args, env.checkout.worktree);
    if (result.exitCode !== 0 || result.timedOut === true) return undefined;
    const out = result.stdout;
    const text =
      out.length > CHAIN_DIFF_CHARS
        ? `${out.slice(0, CHAIN_DIFF_CHARS)}\n(diff cut at ${CHAIN_DIFF_CHARS} characters)`
        : out;
    return { source: "diff", ref, text };
  } catch {
    // A failed git read only costs its own evidence entry; the draft is still useful.
    return undefined;
  }
}

export async function buildChainQuestion(
  env: BotFixEnv,
  finding: ChainFinding,
  feature: string,
): Promise<QuestionDraft> {
  const { item } = finding;
  const lineage = item.lineage;
  const pushSha = lineage?.pushSha ?? "";
  const parents = lineage?.parents ?? [];
  const evidence: AdviceEvidence[] = [
    { source: "finding", text: findingText(item) },
    { source: "review-round", text: reviewRoundText(env, item, pushSha, parents) },
  ];
  if (item.file !== undefined) {
    const range = `${env.checkout.mergeBase}..HEAD`;
    const [diff, show] = await Promise.all([
      gitEvidence(env, ["diff", range, "--", item.file], item.file),
      gitEvidence(env, ["show", pushSha, "--", item.file], pushSha),
    ]);
    for (const entry of [diff, show]) if (entry !== undefined) evidence.push(entry);
  }
  return {
    kind: "bot-fix-chain",
    feature,
    options: buildMenu({ kind: "bot-fix-chain" }),
    findingSeverity: item.severity,
    ...(item.file === undefined ? {} : { anchorFile: item.file }),
    rulingTitle: item.issue.split("\n")[0] ?? item.issue,
    dedupeKey: chainRulingKey(item.key),
    summary: `Finding ${item.key} (${item.severity}) sits at generation ${lineage?.generation ?? 0} on lines nax bot fix ${pushSha.slice(0, SHORT_SHA_LENGTH)} added.`,
    evidence,
  };
}
