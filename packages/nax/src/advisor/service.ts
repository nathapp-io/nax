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
import { getSafeLogger } from "../logger";
import type { AdviseOpInput, AdviseOpOutput, CallContext } from "../operations";
import { adviseOp } from "../operations";
import { buildAdvisorPrompt } from "../prompts";
import { NAX_COMMIT, NAX_VERSION } from "../version";
import type { AdviceAuditRecord } from "./audit";
import { writeAdviceAudit } from "./audit";
import { adviseBatch, type BatchRequest, type BatchResult } from "./batch";
import { ladderModels } from "./ladder";
import { appendDecision, readTrustedDecisions } from "./ledger";
import {
  _advisorServiceDeps,
  type AdvisorCallContext,
  configOf,
  decisionDraftFor,
  deliverHeadsUp,
  describeModel,
  isCoolingFor,
  type QuestionDraft,
} from "./service-helpers";
import type { AdviceDecision, AdviceQuestion, AdviceResult } from "./types";

export { _advisorServiceDeps, type AdvisorCallContext, type QuestionDraft };

export interface Advisor {
  advise(question: QuestionDraft, opts?: { findingSeverity?: string }): Promise<AdviceResult>;
  recordReuse(question: QuestionDraft, from: AdviceDecision): Promise<AdviceDecision | null>;
  adviseBatch(req: BatchRequest): Promise<BatchResult>;
}

/** Per (run, feature) warm-session state: whether the session has seen the full context, and the call chain. */
const warmSessions = new Map<string, { opened: boolean; tail: Promise<unknown> }>();

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
  /** The ladder entry that produced `out` (the last one tried when none answered). */
  model?: AdvisorConfig["model"];
  attempts?: Array<{ model: string; error: string }>;
}

async function prepare(actx: AdvisorCallContext, draft: QuestionDraft): Promise<Asked> {
  // Only decisions the advisor itself wrote (audit artifact matches) inform the next one.
  const priorDecisions = await readTrustedDecisions(actx.repoRoot, actx.feature, actx.outputDir);
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
  model: AdvisorConfig["model"] = configOf(actx).model,
): Promise<OpRun> {
  const config = configOf(actx);
  const input: AdviseOpInput = {
    question: asked.question,
    specPath: actx.specPath,
    prdText: asked.prdText,
    priorDecisions: asked.priorDecisions,
    continuation,
    keepOpen,
    model,
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
  };
  const prompt = buildAdvisorPrompt(input);
  const ctx: CallContext = { ...actx.callCtx, sessionOverride: { role: "advisor", discriminator: "advisor" } };
  try {
    return { out: await _advisorServiceDeps.callOp(ctx, adviseOp, input), prompt, model };
  } catch (err) {
    return { out: null, error: `dispatch: ${errorMessage(err)}`, prompt, model };
  }
}

function failureOf(run: OpRun): string {
  if (run.out && !run.out.ok) return run.out.error;
  return run.error ?? "no-output";
}

/** A5 W-R10: stateless calls walk the model ladder, skipping cooled-down entries, until one answers. */
async function runLadder(actx: AdvisorCallContext, asked: Asked, config: AdvisorConfig): Promise<OpRun> {
  const models = ladderModels(config, isCoolingFor(actx));
  const attempts: Array<{ model: string; error: string }> = [];
  let last: OpRun = { out: null, prompt: "" };
  for (const model of models) {
    last = await callOnce(actx, asked, false, false, model);
    if (last.out?.ok) break;
    attempts.push({ model: describeModel(model), error: failureOf(last) });
  }
  return { ...last, ...(attempts.length > 0 ? { attempts } : {}) };
}

async function runOp(actx: AdvisorCallContext, asked: Asked): Promise<OpRun> {
  const config = configOf(actx);
  if (config.memory !== "warm") return runLadder(actx, asked, config);
  // Warm memory stays primary-only: the warm session is bound to one model (spec section 8).
  const entry = warmEntry(actx);
  const first = await callOnce(actx, asked, entry.opened, true);
  if (first.out?.ok) {
    entry.opened = true;
    return first;
  }
  if (!entry.opened) return first;
  // The warm session was lost or confused: rebuild it from the ledger and retry once,
  // then fall back to one stateless call for this question (spec §4.5).
  entry.opened = false;
  const retry = await callOnce(actx, asked, false, true);
  if (retry.out?.ok) {
    entry.opened = true;
    return retry;
  }
  return callOnce(actx, asked, false, false);
}

function warmEntry(actx: AdvisorCallContext): { opened: boolean; tail: Promise<unknown> } {
  // The agent session's own identity: run, feature, story (or feature-level) and workdir.
  // A coarser key would send a brand-new session a "continuation" with no context.
  const key = `${actx.runId}|${actx.feature}|${actx.callCtx.storyId ?? "_feature"}|${actx.workdir}`;
  const existing = warmSessions.get(key);
  if (existing) return existing;
  const created = { opened: false, tail: Promise.resolve() as Promise<unknown> };
  warmSessions.set(key, created);
  return created;
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
    model: describeModel(a.run.model ?? config.model),
    ...(a.run.attempts ? { attempts: a.run.attempts } : {}),
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
  const draft = decisionDraftFor(actx, asked.question, run.out.reply, run.model ?? configOf(actx).model, severity);
  if (!draft) return { decision: null, fallbackReason: `optionId ${run.out.reply.optionId} is not on the menu` };
  try {
    return { decision: await appendDecision(actx.repoRoot, actx.feature, draft) };
  } catch (err) {
    return { decision: null, fallbackReason: `ledger: ${errorMessage(err)}` };
  }
}

/** Every failure — including one before the op runs (worktree snapshot, ledger read) — is a fallback, never a throw. */
async function adviseSafely(actx: AdvisorCallContext, draft: QuestionDraft, severity?: string): Promise<AdviceResult> {
  try {
    return await adviseOnce(actx, draft, severity);
  } catch (err) {
    const fallbackReason = `advisor error: ${errorMessage(err)}`;
    getSafeLogger()?.warn("advisor", "Advisor failed — caller keeps today's behaviour", {
      storyId: draft.storyId ?? "_run",
      kind: draft.kind,
      reason: fallbackReason,
    });
    return { decision: null, fallbackReason };
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
      const run = () => adviseSafely(actx, question, opts?.findingSeverity);
      if (configOf(actx).memory !== "warm") return run();
      // Warm: serialise this feature's questions on one session.
      const entry = warmEntry(actx);
      const next = entry.tail.then(run, run);
      entry.tail = next.catch(() => undefined);
      return next;
    },
    recordReuse: (question, from) => recordReuseImpl(actx, question, from),
    adviseBatch: (req) => adviseBatch(actx, req),
  };
}
