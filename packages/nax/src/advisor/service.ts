/**
 * A1 advisor service (spec §4.1–§4.10, §12). One entry point: `advise(question)`.
 *
 * Pipeline: ledger → worktree snapshot → `adviseOp` (stateless or warm) →
 * menu validation (in the op) → action + forced-confirm guardrails → ledger
 * append → audit artifact → heads-up. Every failure returns `decision: null`
 * with a reason; the caller then does what it does today.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdvisorConfig } from "../config";
import { featureDir, resolveAdvisorConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { AdviseOpInput, AdviseOpOutput, CallContext } from "../operations";
import { adviseOp, callOp } from "../operations";
import { buildAdvisorPrompt } from "../prompts";
import type { NaxRuntime } from "../runtime";
import { totalSpendUsd } from "../runtime/cost-aggregator";
import { NAX_COMMIT, NAX_VERSION } from "../version";
import type { AdviceAuditRecord } from "./audit";
import { captureWorktreePatch, writeAdviceAudit } from "./audit";
import type { HeadsUpChannel } from "./heads-up";
import { formatHeadsUp } from "./heads-up";
import { appendDecision, readDecisions } from "./ledger";
import { forcedConfirm, toAction } from "./menus";
import type { AdviceDecision, AdviceQuestion, AdviceResult, AdvisorReply } from "./types";

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

export interface Advisor {
  advise(question: QuestionDraft, opts?: { findingSeverity?: string }): Promise<AdviceResult>;
  recordReuse(question: QuestionDraft, from: AdviceDecision): Promise<AdviceDecision | null>;
}

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

/** Per (run, feature) warm-session state: whether the session has seen the full context, and the call chain. */
const warmSessions = new Map<string, { opened: boolean; tail: Promise<unknown> }>();

function configOf(actx: AdvisorCallContext): AdvisorConfig {
  return resolveAdvisorConfig(actx.callCtx.config ?? actx.callCtx.runtime.configLoader.current());
}

function describeModel(model: AdvisorConfig["model"]): string {
  return typeof model === "string" ? model : `${model.agent}:${model.model}`;
}

interface Asked {
  question: AdviceQuestion;
  priorDecisions: AdviceDecision[];
  prdText: string;
  worktree: AdviceAuditRecord["worktree"];
}

interface OpRun {
  out: AdviseOpOutput | null;
  error?: string;
  prompt: string;
}

async function prepare(actx: AdvisorCallContext, draft: QuestionDraft): Promise<Asked> {
  const priorDecisions = await readDecisions(actx.repoRoot, actx.feature);
  const worktree = await _advisorServiceDeps.captureWorktreePatch(actx.workdir);
  const question: AdviceQuestion = { ...draft, id: _advisorServiceDeps.newId(), askedAtSha: worktree.sha };
  const prdText = await _advisorServiceDeps.readPrdText(actx.repoRoot, actx.feature);
  return { question, priorDecisions, prdText, worktree };
}

async function callOnce(
  actx: AdvisorCallContext,
  asked: Asked,
  continuation: boolean,
  keepOpen: boolean,
): Promise<OpRun> {
  const config = configOf(actx);
  const input: AdviseOpInput = {
    question: asked.question,
    specPath: actx.specPath,
    prdText: asked.prdText,
    priorDecisions: asked.priorDecisions,
    continuation,
    keepOpen,
    model: config.model,
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
  };
  const prompt = buildAdvisorPrompt(input);
  const ctx: CallContext = { ...actx.callCtx, sessionOverride: { role: "advisor", discriminator: "advisor" } };
  try {
    return { out: await _advisorServiceDeps.callOp(ctx, adviseOp, input), prompt };
  } catch (err) {
    return { out: null, error: `dispatch: ${errorMessage(err)}`, prompt };
  }
}

async function runOp(actx: AdvisorCallContext, asked: Asked): Promise<OpRun> {
  if (configOf(actx).memory !== "warm") return callOnce(actx, asked, false, false);
  const entry = warmEntry(actx);
  const first = await callOnce(actx, asked, entry.opened, true);
  if (first.out?.ok) {
    entry.opened = true;
    return first;
  }
  if (!entry.opened) return first;
  // The warm session was lost or confused: rebuild it from the ledger and retry once.
  entry.opened = false;
  const retry = await callOnce(actx, asked, false, true);
  if (retry.out?.ok) entry.opened = true;
  return retry;
}

function warmEntry(actx: AdvisorCallContext): { opened: boolean; tail: Promise<unknown> } {
  const key = `${actx.runId}|${actx.feature}`;
  const existing = warmSessions.get(key);
  if (existing) return existing;
  const created = { opened: false, tail: Promise.resolve() as Promise<unknown> };
  warmSessions.set(key, created);
  return created;
}

function buildDraft(
  actx: AdvisorCallContext,
  asked: Asked,
  reply: AdvisorReply,
  findingSeverity: string | undefined,
): ((id: string) => Omit<AdviceDecision, "id">) | null {
  const option = asked.question.options.find((o) => o.id === reply.optionId);
  if (!option) return null;
  const action = toAction(option, reply);
  const config = configOf(actx);
  return (id) => ({
    questionId: asked.question.id,
    kind: asked.question.kind,
    ...(asked.question.storyId ? { storyId: asked.question.storyId } : {}),
    ...(asked.question.dedupeKey ? { dedupeKey: asked.question.dedupeKey } : {}),
    chosenOptionId: option.id,
    action,
    rationale: reply.rationale,
    confidence: reply.confidence,
    reversible: reply.reversible,
    needsHumanConfirm: forcedConfirm(action, reply, findingSeverity),
    decidedAt: _advisorServiceDeps.now(),
    model: describeModel(config.model),
    memoryMode: config.memory,
    auditRef: join("advisor-audit", actx.feature, `${id}.json`),
  });
}

async function deliverHeadsUp(
  actx: AdvisorCallContext,
  decision: AdviceDecision,
  question: AdviceQuestion,
): Promise<{ sent: boolean; reason?: string }> {
  if (!decision.needsHumanConfirm) return { sent: false, reason: "not-flagged" };
  if (!configOf(actx).notify.headsUp) return { sent: false, reason: "heads-up-disabled" };
  const text = formatHeadsUp(decision, question);
  if (actx.headsUp) {
    try {
      return await actx.headsUp(text);
    } catch (err) {
      return { sent: false, reason: `delivery-failed: ${errorMessage(err)}` };
    }
  }
  if (actx.queueHeadsUp && question.storyId) {
    actx.queueHeadsUp(question.storyId, text);
    return { sent: false, reason: "queued-for-stage" };
  }
  getSafeLogger()?.warn("advisor", "Flagged advisor decision has no delivery channel", {
    storyId: question.storyId ?? "_run",
    decisionId: decision.id,
  });
  return { sent: false, reason: "no-channel" };
}

interface AuditInput {
  asked: Asked;
  run: OpRun;
  result: AdviceResult;
  costUsd: number;
  headsUp: { sent: boolean; reason?: string };
}

async function writeAuditSafe(actx: AdvisorCallContext, a: AuditInput): Promise<void> {
  const config = configOf(actx);
  const record: AdviceAuditRecord = {
    schemaVersion: 1,
    naxVersion: NAX_VERSION,
    naxCommit: NAX_COMMIT,
    runId: actx.runId,
    question: a.asked.question,
    context: { specPath: actx.specPath, specSha256: null, prdSha256: null, priorDecisions: a.asked.priorDecisions },
    worktree: a.asked.worktree,
    memoryMode: config.memory,
    model: describeModel(config.model),
    prompt: a.run.prompt,
    rawReply: a.run.out ? JSON.stringify(a.run.out) : (a.run.error ?? ""),
    result: a.result,
    costUsd: a.costUsd,
    headsUp: a.headsUp,
  };
  try {
    await writeAdviceAudit(actx.outputDir, actx.feature, record);
  } catch (err) {
    getSafeLogger()?.warn("advisor", "Advisor audit write failed — decision stands", {
      storyId: a.asked.question.storyId ?? "_run",
      error: errorMessage(err),
    });
  }
}

async function adviseOnce(actx: AdvisorCallContext, draft: QuestionDraft, severity?: string): Promise<AdviceResult> {
  const asked = await prepare(actx, draft);
  const costBefore = _advisorServiceDeps.costTotal(actx.callCtx.runtime);
  const run = await runOp(actx, asked);
  const costUsd = _advisorServiceDeps.costTotal(actx.callCtx.runtime) - costBefore;
  const result = await decide(actx, asked, run, severity);
  const headsUp = result.decision
    ? await deliverHeadsUp(actx, result.decision, asked.question)
    : { sent: false, reason: "no-decision" };
  await writeAuditSafe(actx, { asked, run, result, costUsd, headsUp });
  logOutcome(asked.question, result);
  return result;
}

async function decide(actx: AdvisorCallContext, asked: Asked, run: OpRun, severity?: string): Promise<AdviceResult> {
  if (!run.out) return { decision: null, fallbackReason: run.error ?? "no-output" };
  if (!run.out.ok) return { decision: null, fallbackReason: run.out.error };
  const draft = buildDraft(actx, asked, run.out.reply, severity);
  if (!draft) return { decision: null, fallbackReason: `optionId ${run.out.reply.optionId} is not on the menu` };
  try {
    return { decision: await appendDecision(actx.repoRoot, actx.feature, draft) };
  } catch (err) {
    return { decision: null, fallbackReason: `ledger: ${errorMessage(err)}` };
  }
}

function logOutcome(question: AdviceQuestion, result: AdviceResult): void {
  const logger = getSafeLogger();
  const base = { storyId: question.storyId ?? "_run", questionId: question.id, kind: question.kind };
  if (result.decision) {
    logger?.info("advisor", "Advisor decided", {
      ...base,
      decisionId: result.decision.id,
      action: result.decision.action.type,
      needsHumanConfirm: result.decision.needsHumanConfirm,
    });
  } else {
    logger?.warn("advisor", "Advisor fell back — caller keeps today's behaviour", {
      ...base,
      reason: result.fallbackReason,
    });
  }
}

async function recordReuseImpl(
  actx: AdvisorCallContext,
  draft: QuestionDraft,
  from: AdviceDecision,
): Promise<AdviceDecision | null> {
  const asked = await prepare(actx, draft);
  try {
    const decision = await appendDecision(actx.repoRoot, actx.feature, (id) => {
      const { id: _from, ...rest } = from;
      return {
        ...rest,
        questionId: asked.question.id,
        reusedFrom: from.id,
        decidedAt: _advisorServiceDeps.now(),
        auditRef: join("advisor-audit", actx.feature, `${id}.json`),
      };
    });
    const run: OpRun = { out: null, prompt: "" };
    await writeAuditSafe(actx, {
      asked,
      run,
      result: { decision },
      costUsd: 0,
      headsUp: { sent: false, reason: "reused" },
    });
    return decision;
  } catch (err) {
    getSafeLogger()?.warn("advisor", "Reusing an advisor decision failed", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return null;
  }
}

export function createAdvisor(actx: AdvisorCallContext): Advisor {
  return {
    advise(question, opts) {
      const run = () => adviseOnce(actx, question, opts?.findingSeverity);
      if (configOf(actx).memory !== "warm") return run();
      // Warm: serialise this feature's questions on one session.
      const entry = warmEntry(actx);
      const next = entry.tail.then(run, run);
      entry.tail = next.catch(() => undefined);
      return next;
    },
    recordReuse: (question, from) => recordReuseImpl(actx, question, from),
  };
}
