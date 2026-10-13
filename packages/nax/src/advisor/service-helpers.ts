/**
 * Shared advisor-service internals: the call context, injectable deps, and the pieces `advise()`
 * and `adviseBatch()` both use (decision drafting, heads-up delivery, ladder cooling). Kept apart
 * from `service.ts` so `batch.ts` and `service.ts` do not import each other.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdvisorConfig } from "../config";
import { featureDir, resolveAdvisorConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { CallContext } from "../operations";
import { callOp } from "../operations";
import type { NaxRuntime } from "../runtime";
import { totalSpendUsd } from "../runtime/cost-aggregator";
import { captureWorktreePatch } from "./audit";
import type { HeadsUpChannel } from "./heads-up";
import { formatHeadsUp } from "./heads-up";
import { forcedConfirm, toAction } from "./menus";
import type { AdviceDecision, AdviceQuestion, AdvisorReply } from "./types";

export interface AdvisorCallContext {
  callCtx: CallContext;
  /** The MAIN checkout (ledger location), never a story worktree. */
  repoRoot: string;
  outputDir: string;
  feature: string;
  runId: string;
  specPath: string;
  /** Where the question is being asked (story worktree or package dir). */
  workdir: string;
  headsUp?: HeadsUpChannel;
  queueHeadsUp?: (storyId: string, text: string) => void;
}

export type QuestionDraft = Omit<AdviceQuestion, "id" | "askedAtSha">;

export const _advisorServiceDeps = {
  callOp: callOp as <I, O, C>(ctx: CallContext, op: import("../operations").Operation<I, O, C>, input: I) => Promise<O>,
  now: (): string => new Date().toISOString(),
  newId: (): string => `Q-${crypto.randomUUID().slice(0, 13)}`,
  captureWorktreePatch,
  readPrdText: async (repoRoot: string, feature: string): Promise<string> => {
    try {
      return await Bun.file(join(featureDir(repoRoot, feature), "prd.json")).text();
    } catch {
      // No PRD (ad-hoc call, deleted feature dir): the advisor still has the spec and the question.
      return "{}";
    }
  },
  costTotal: (runtime: NaxRuntime): number => totalSpendUsd(runtime.costAggregator.snapshot()),
};

/** The `isCooling` predicate both the single and the batch ladder use. */
export function isCoolingFor(actx: AdvisorCallContext): (m: AdvisorConfig["model"]) => boolean {
  const agentManager = actx.callCtx.runtime?.agentManager;
  return (m) => (typeof m === "string" ? false : (agentManager?.isUnavailable(m.agent, undefined, m.model) ?? false));
}

export function configOf(actx: AdvisorCallContext): AdvisorConfig {
  return resolveAdvisorConfig(actx.callCtx.config ?? actx.callCtx.runtime.configLoader.current());
}

export function describeModel(model: AdvisorConfig["model"]): string {
  return typeof model === "string" ? model : `${model.agent}:${model.model}`;
}

export function decisionDraftFor(
  actx: AdvisorCallContext,
  question: AdviceQuestion,
  reply: AdvisorReply,
  answeredBy: AdvisorConfig["model"],
  findingSeverity: string | undefined,
  memoryMode?: AdviceDecision["memoryMode"],
): ((id: string) => Omit<AdviceDecision, "id">) | null {
  const option = question.options.find((o) => o.id === reply.optionId);
  if (!option) return null;
  const action = toAction(option, reply);
  const config = configOf(actx);
  return (id) => ({
    questionId: question.id,
    kind: question.kind,
    ...(question.storyId ? { storyId: question.storyId } : {}),
    ...(question.dedupeKey ? { dedupeKey: question.dedupeKey } : {}),
    ...(question.anchorFile ? { anchorFile: question.anchorFile } : {}),
    ...(question.rulingTitle ? { rulingTitle: question.rulingTitle } : {}),
    ...(action.type === "fix" && action.updateAcs ? { acceptanceChanges: action.updateAcs } : {}),
    ...((findingSeverity ?? question.findingSeverity)
      ? { findingSeverity: findingSeverity ?? question.findingSeverity }
      : {}),
    chosenOptionId: option.id,
    action,
    rationale: reply.rationale,
    confidence: reply.confidence,
    reversible: reply.reversible,
    needsHumanConfirm: forcedConfirm(action, reply, findingSeverity),
    decidedAt: _advisorServiceDeps.now(),
    model: describeModel(answeredBy),
    memoryMode: memoryMode ?? config.memory,
    auditRef: join("advisor-audit", actx.feature, `${id}.json`),
  });
}

export async function deliverHeadsUp(
  actx: AdvisorCallContext,
  decision: AdviceDecision,
  question: AdviceQuestion,
): Promise<{ sent: boolean; reason?: string }> {
  if (!decision.needsHumanConfirm) return { sent: false, reason: "not-flagged" };
  if (!configOf(actx).notify.headsUp) return { sent: false, reason: "heads-up-disabled" };
  const text = formatHeadsUp(decision, question);
  if (actx.headsUp) {
    // Promise chain, not try/await: biome's useAwaitThenable misreads the function-typed field.
    return actx
      .headsUp(text)
      .catch((err: unknown) => ({ sent: false, reason: `delivery-failed: ${errorMessage(err)}` }));
  }
  if (actx.queueHeadsUp && question.storyId) {
    actx.queueHeadsUp(question.storyId, text);
    return { sent: false, reason: "queued-for-stage" };
  }
  // The ruling's own log line says "flagged, no delivery channel" (nax#2491 P4); this stays for the JSONL only.
  getSafeLogger()?.debug("advisor", "Flagged advisor decision has no delivery channel", {
    storyId: question.storyId ?? "_run",
    decisionId: decision.id,
  });
  return { sent: false, reason: "no-channel" };
}
