/**
 * Judge selector strategy.
 *
 * Dispatches via callOp(ctx.callContext, judgeOp, …) — audit, cost, and retry
 * middleware fire through the standard operation layer.
 *
 * Compat note: callJudgeComplete has been moved to src/debate/resolvers.ts so that
 * resolvers.ts can call agentManager.completeAs without this file doing so directly.
 * The debate barrel (index.ts) continues to re-export callJudgeComplete from resolvers.
 */

import { getSafeLogger } from "@/logger";
import { callOp } from "@/operations";
import { judgeOp } from "@/operations";
import type { Selector, SelectorContext, SelectorResult } from "./types";

const RESOLVER_FALLBACK_AGENT = "synthesis";
const RESOLVER_FALLBACK_MODEL = "fast";

/**
 * Matches the `JUDGE_VERDICT: ACCEPT|REJECT` marker line the prompt requires
 * (resolverJudgePrompt), tolerating common decoration a model wraps it in —
 * markdown bold/code-fence/heading/blockquote prefixes — and requiring a word
 * boundary after the verdict so "ACCEPTED" doesn't match "ACCEPT".
 */
const VERDICT_LINE_PATTERN = /^[\s*_`#>]*JUDGE_VERDICT\s*:\s*(ACCEPT|REJECT)\b/i;
/** How many leading lines to scan for the marker — tolerates a short preamble before it. */
const MAX_VERDICT_SCAN_LINES = 5;

/**
 * Parse the judge's verdict marker (scanning the first few lines) and strip
 * that line from the returned text. A judge asked for a verdict must be
 * graded on that verdict, not on "is the output non-empty" — a rejection
 * explanation is non-empty prose too (BUG-32). Absence of a parseable marker
 * (the agent ignored the instruction) fails closed rather than falling back
 * to the old any-text-passes behaviour.
 */
function parseJudgeVerdict(output: string): { outcome: "passed" | "failed"; output: string } {
  const lines = output.split("\n");
  for (let i = 0; i < Math.min(lines.length, MAX_VERDICT_SCAN_LINES); i++) {
    const match = lines[i]?.match(VERDICT_LINE_PATTERN);
    if (!match) continue;
    const verdict = match[1] ?? "REJECT";
    const stripped = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
    return { outcome: verdict.toUpperCase() === "ACCEPT" ? "passed" : "failed", output: stripped };
  }
  getSafeLogger()?.warn("debate", "judge response missing JUDGE_VERDICT marker — failing closed", {
    outputPreview: output.slice(0, 200),
  });
  return { outcome: "failed", output };
}

export const judgeSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const resolverAgent = ctx.stageConfig.resolver.agent ?? RESOLVER_FALLBACK_AGENT;
  const resolverModel = ctx.stageConfig.resolver.model ?? RESOLVER_FALLBACK_MODEL;
  const proposals = ctx.proposals.map((p) => p.output);

  const rawOutput = await callOp(ctx.callContext, judgeOp, {
    proposals,
    critiques: ctx.critiques,
    debaters: ctx.debaters,
    resolverAgent,
    resolverModel,
    timeoutSeconds: ctx.stageConfig.timeoutSeconds,
  });

  if (!rawOutput.trim()) {
    return { outcome: "failed", output: rawOutput };
  }

  const { outcome, output } = parseJudgeVerdict(rawOutput);
  return { outcome, output };
};
