/** Ready or draft (spec §7 step 8, P4-R6, P4-R10): deterministic reasons first, the advisor only when none apply. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Advisor, QuestionDraft } from "@/advisor";
import { buildMenu } from "@/advisor";
import { getSafeLogger } from "@/logger";
import { isFlaggedRuling } from "./advisor";
import type { PreflightFile } from "./preflight";
import type { FeatureCiState, RepoGateSummary, StoryState, StorySummary, WorkflowRuling } from "./types";

export interface ReadinessFacts {
  readonly finalGates?: RepoGateSummary;
  readonly ci: FeatureCiState;
  readonly stories: readonly StorySummary[];
  readonly flagged: number;
  readonly branchReviewRan: boolean;
}

const NOTHING_VERIFIED = "no quality commands configured — nothing was verified";

function idsIn(stories: readonly StorySummary[], state: StoryState): string[] {
  return stories.filter((s) => s.state === state).map((s) => s.id);
}

function gateReasons(gates: RepoGateSummary | undefined): string[] {
  if (!gates || gates.ran.length === 0) return [NOTHING_VERIFIED];
  return gates.failing.length > 0 ? [`gates red: ${gates.failing.join(", ")}`] : [];
}

/** Why the PR can't be ready, in a stable order; empty = ask the advisor. CI pending never blocks (W-R9). */
export function readinessReasons(f: ReadinessFacts): string[] {
  const gateOpen = idsIn(f.stories, "complete-gate-open");
  const notRun = idsIn(f.stories, "not-run");
  return [
    ...gateReasons(f.finalGates),
    ...(f.ci === "failed" ? ["CI failed"] : []),
    ...(gateOpen.length > 0 ? [`stories gate-open: ${gateOpen.join(", ")}`] : []),
    ...(notRun.length > 0 ? [`stories not run: ${notRun.join(", ")}`] : []),
    ...(f.flagged > 0 ? [`${f.flagged} ruling(s) flagged for a human`] : []),
    ...(f.branchReviewRan ? [] : ["branch review did not run"]),
  ];
}

/** RunResult.success for workflow mode (spec §7, P4-R13). */
export function featurePassed(f: Pick<ReadinessFacts, "finalGates" | "stories">): boolean {
  const storiesOk = f.stories.every((s) => s.state !== "complete-gate-open" && s.state !== "not-run");
  return storiesOk && (f.finalGates?.failing.length ?? 0) === 0;
}

export function flaggedCount(
  stories: readonly StorySummary[],
  preflight: PreflightFile | null,
  rulings: readonly WorkflowRuling[],
): number {
  const storyFlags = stories.reduce((n, s) => n + s.flagged, 0);
  const preflightHolds = (preflight?.conflicts ?? []).filter((c) => c.action === "hold").length;
  return storyFlags + preflightHolds + rulings.filter(isFlaggedRuling).length;
}

export async function askApproval(
  advisor: Advisor,
  input: { readonly feature: string; readonly evidence: readonly string[] },
): Promise<{ approved: boolean; rationale: string }> {
  const draft: QuestionDraft = {
    kind: "finish-approval",
    feature: input.feature,
    summary: `Approve the workflow PR for ${input.feature}? Every deterministic ready condition holds.`,
    evidence: input.evidence.map((text) => ({ source: "review-round", text })),
    options: buildMenu({
      kind: "finish-approval",
      allPhasesComplete: true,
      gatesGreen: true,
      reReviewUsed: true,
      reReviewPhase: "quality",
    }),
  };
  try {
    const { decision, fallbackReason } = await advisor.advise(draft);
    if (!decision) return { approved: false, rationale: `advisor unavailable: ${fallbackReason ?? "no decision"}` };
    return decision.action.type === "approve"
      ? { approved: true, rationale: decision.rationale }
      : { approved: false, rationale: `advisor held: ${decision.rationale}` };
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Approval advisor failed — the PR stays a draft", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return { approved: false, rationale: `advisor unavailable: ${errorMessage(err)}` };
  }
}
