/**
 * A1 run summary (spec §4.11): advisor decision counts into status.json and the
 * completion log. Trusted ledger lines only; nothing at all when the advisor is
 * off, so status.json is unchanged for everyone else.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdvisorSummary } from "@/advisor/store";
import { readTrustedDecisions, summariseAdvisor } from "@/advisor/store";
import type { NaxConfig } from "@/config";
import { resolveAdvisorConfig } from "@/config";
import { getSafeLogger } from "@/logger";

export async function recordAdvisorSummary(args: {
  config: NaxConfig;
  statusWriter: { setAdvisorSummary?: (s: AdvisorSummary) => void };
  repoRoot: string;
  feature: string;
  outputDir: string | undefined;
}): Promise<void> {
  if (!resolveAdvisorConfig(args.config).enabled || !args.outputDir) return;
  try {
    const summary = summariseAdvisor(await readTrustedDecisions(args.repoRoot, args.feature, args.outputDir));
    args.statusWriter.setAdvisorSummary?.(summary);
    getSafeLogger()?.info("advisor", "Advisor decisions this feature", { storyId: "_run", ...summary });
  } catch (err) {
    getSafeLogger()?.warn("advisor", "Advisor summary unavailable", { storyId: "_run", error: errorMessage(err) });
  }
}
