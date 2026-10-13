/**
 * A1 run summary (spec §4.11): advisor decision counts into status.json and the
 * completion log. Trusted ledger lines only; nothing at all when the advisor is
 * off, so status.json is unchanged for everyone else.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdviceDecision, AdvisorSummary } from "@/advisor/store";
import { decisionBody, readTrustedDecisions, summariseAdvisor } from "@/advisor/store";
import type { NaxConfig } from "@/config";
import { resolveAdvisorConfig } from "@/config";
import { getSafeLogger } from "@/logger";

/** The end-of-feature block (nax#2491 P4): the count, then each decision, or `(none)`. */
function logFeatureDecisions(decisions: readonly AdviceDecision[], summary: AdvisorSummary): void {
  const logger = getSafeLogger();
  if (decisions.length === 0) {
    logger?.info("advisor", "Advisor decisions this feature: (none)", { storyId: "_run", ...summary });
    return;
  }
  const flagged = summary.flagged > 0 ? ` (${summary.flagged} flagged)` : "";
  logger?.info("advisor", `Advisor decisions this feature: ${decisions.length}${flagged}`, {
    storyId: "_run",
    ...summary,
  });
  for (const d of decisions) logger?.info("advisor", `  ${d.id} ${decisionBody(d)}`, { storyId: d.storyId ?? "_run" });
}

export async function recordAdvisorSummary(args: {
  config: NaxConfig;
  statusWriter: { setAdvisorSummary?: (s: AdvisorSummary) => void };
  repoRoot: string;
  feature: string;
  outputDir: string | undefined;
}): Promise<void> {
  if (!resolveAdvisorConfig(args.config).enabled || !args.outputDir) return;
  try {
    const decisions = await readTrustedDecisions(args.repoRoot, args.feature, args.outputDir);
    const summary = summariseAdvisor(decisions);
    args.statusWriter.setAdvisorSummary?.(summary);
    logFeatureDecisions(decisions, summary);
  } catch (err) {
    getSafeLogger()?.warn("advisor", "Advisor summary unavailable", { storyId: "_run", error: errorMessage(err) });
  }
}
