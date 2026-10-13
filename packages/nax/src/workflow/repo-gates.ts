/** Repo gates (spec §7 steps 1 and 6, P4-R5): every configured quality command across the feature's packages. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { runQualityQuietly } from "@/quality";
import type { FeatureContext } from "./feature-context";
import { _featureDeps } from "./feature-deps";
import type { RepoGateSummary, WorkflowFindingDraft } from "./types";

export const GATE_EXCERPT_LINES = 40;
const GATE_EXCERPT_CHARS = 4_000;
const CHUNK_SPLIT = /\n\n(?=\[)/;

export interface RepoGateRun {
  readonly summary: RepoGateSummary;
  readonly findings: readonly WorkflowFindingDraft[];
}

/** The tail of one gate's chunk in runQualityGates' combined output (`[name] exit=N\n…`). */
export function gateExcerpt(output: string, name: string): string {
  const chunk = output.split(CHUNK_SPLIT).find((c) => c.startsWith(`[${name}] exit=`)) ?? "";
  const tail = chunk.split("\n").slice(1).slice(-GATE_EXCERPT_LINES).join("\n");
  return tail.length > GATE_EXCERPT_CHARS ? tail.slice(-GATE_EXCERPT_CHARS) : tail;
}

export async function runRepoGates(fc: FeatureContext): Promise<RepoGateRun> {
  try {
    const commands = await _featureDeps.resolveGateCommands(fc.projectDir, [...fc.packageDirs]);
    const res = await runQualityQuietly(() => _featureDeps.runQualityGates(fc.projectDir, commands));
    return {
      summary: { ran: res.ran, failing: res.failing },
      findings: res.failing.map((name) => ({
        kind: "gate" as const,
        severity: "important" as const,
        issue: `repo gate ${name} failed:\n${gateExcerpt(res.output, name)}`,
      })),
    };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return {
      summary: { ran: ["repo-gates"], failing: ["repo-gates"] },
      findings: [{ kind: "gate", severity: "important", issue: `repo gates errored: ${errorMessage(err)}` }],
    };
  }
}
