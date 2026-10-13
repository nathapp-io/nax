/**
 * A5 PR3: `adviseBatch` (spec §8). One stateless op call over the model ladder; every valid
 * answer is a standard decision; a missing or invalid answer is that item's fallback (P3-R3).
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdvisorConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { AdviseBatchOpInput, AdviseBatchOpOutput, CallContext } from "../operations";
import { adviseBatchOp, validateAdvisorReply } from "../operations";
import { buildAdvisorBatchPrompt } from "../prompts";
import { NAX_COMMIT, NAX_VERSION } from "../version";
import type { AdviceAuditRecord } from "./audit";
import { writeAdviceAudit } from "./audit";
import { preflightItems } from "./batch-preflight";
import { logAdvisorDecision } from "./decision-log";
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
import type { AdviceDecision, AdviceQuestion, AdvisorReply } from "./types";

export type BatchRequest =
  | { kind: "residual"; storyId: string; summary: string; items: QuestionDraft[]; redGates: string[] }
  | { kind: "preflight"; summary: string; storyIds: string[] };

export interface BatchItemResult {
  question: AdviceQuestion;
  decision: AdviceDecision | null;
  fallbackReason?: string;
}

export type BatchResult =
  | { kind: "residual"; items: BatchItemResult[]; diagnoses: Record<string, string>; fallbackReason?: string }
  | {
      kind: "preflight";
      items: BatchItemResult[];
      overlap: { storyId: string; specSections: string[] }[];
      fallbackReason?: string;
    };

type OkOutput = Extract<AdviseBatchOpOutput, { ok: true }>;

interface BatchRun {
  out: OkOutput | null;
  error?: string;
  model: AdvisorConfig["model"];
  attempts: Array<{ model: string; error: string }>;
}

async function runBatchLadder(actx: AdvisorCallContext, input: AdviseBatchOpInput): Promise<BatchRun> {
  const config = configOf(actx);
  const attempts: Array<{ model: string; error: string }> = [];
  const ctx: CallContext = { ...actx.callCtx, sessionOverride: { role: "advisor", discriminator: "advisor-batch" } };
  let last = config.model;
  for (const model of ladderModels(config, isCoolingFor(actx))) {
    last = model;
    try {
      const out = await _advisorServiceDeps.callOp(ctx, adviseBatchOp, {
        ...input,
        model,
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
      });
      if (out.ok) return { out, model, attempts };
      attempts.push({ model: describeModel(model), error: out.error });
    } catch (err) {
      attempts.push({ model: describeModel(model), error: `dispatch: ${errorMessage(err)}` });
    }
  }
  return { out: null, error: attempts.at(-1)?.error ?? "no-output", model: last, attempts };
}

interface Pending {
  question: AdviceQuestion;
  reply?: AdvisorReply;
  error?: string;
  appliesTo?: string[];
  raw: unknown;
}

function residualPending(questions: AdviceQuestion[], out: OkOutput): Pending[] {
  return questions.map((question): Pending => {
    const answer = out.answers.find((a) => a.itemId === question.id);
    if (!answer) return { question, error: "no answer for this item", raw: null };
    return {
      question,
      reply: answer.reply,
      error: answer.error ?? (answer.reply ? undefined : "no answer"),
      raw: answer.raw,
    };
  });
}

function preflightPending(
  out: OkOutput,
  req: Extract<BatchRequest, { kind: "preflight" }>,
  feature: string,
  sha: string,
): Pending[] {
  const base = { feature, askedAtSha: sha, newId: () => _advisorServiceDeps.newId() };
  return preflightItems(out.conflicts, req.storyIds, base).map(({ question, appliesTo, raw }): Pending => {
    const checked = validateAdvisorReply(raw, question.options);
    return checked.ok
      ? { question, reply: checked.reply, appliesTo, raw }
      : { question, error: checked.error, appliesTo, raw };
  });
}

async function decide(actx: AdvisorCallContext, run: BatchRun, p: Pending): Promise<BatchItemResult> {
  if (!p.reply) return { question: p.question, decision: null, fallbackReason: p.error ?? "no answer" };
  const draft = decisionDraftFor(actx, p.question, p.reply, run.model, p.question.findingSeverity, "stateless");
  if (!draft) {
    return { question: p.question, decision: null, fallbackReason: `optionId ${p.reply.optionId} is not on the menu` };
  }
  try {
    const decision = await appendDecision(actx.repoRoot, actx.feature, (id) => {
      const base = draft(id);
      const appliesTo = p.appliesTo ?? (base.action.type === "carry" ? base.action.toStories : undefined);
      return appliesTo ? { ...base, appliesTo } : base;
    });
    return { question: p.question, decision };
  } catch (err) {
    return { question: p.question, decision: null, fallbackReason: `ledger: ${errorMessage(err)}` };
  }
}

interface AuditCtx {
  actx: AdvisorCallContext;
  run: BatchRun;
  prompt: string;
  worktree: AdviceAuditRecord["worktree"];
  priorDecisions: AdviceDecision[];
  costUsd: number;
}

async function auditItem(a: AuditCtx, item: BatchItemResult, raw: unknown, headsUp: AdviceAuditRecord["headsUp"]) {
  const { actx, run } = a;
  const record: AdviceAuditRecord = {
    schemaVersion: 1,
    naxVersion: NAX_VERSION,
    naxCommit: NAX_COMMIT,
    runId: actx.runId,
    question: item.question,
    context: { specPath: actx.specPath, specSha256: null, prdSha256: null, priorDecisions: a.priorDecisions },
    worktree: a.worktree,
    memoryMode: "stateless",
    model: describeModel(run.model),
    ...(run.attempts.length > 0 ? { attempts: run.attempts } : {}),
    prompt: a.prompt,
    rawReply: JSON.stringify(raw ?? run.error ?? ""),
    result: { decision: item.decision, ...(item.fallbackReason ? { fallbackReason: item.fallbackReason } : {}) },
    costUsd: a.costUsd,
    headsUp,
  };
  try {
    await writeAdviceAudit(actx.outputDir, actx.feature, record);
  } catch (err) {
    getSafeLogger()?.warn("advisor", "Advisor audit write failed — decision stands", {
      storyId: item.question.storyId ?? "_run",
      error: errorMessage(err),
    });
  }
}

/** Heads-up + audit for one item; a failure here never undoes decisions already appended (M7). */
async function finishItem(a: AuditCtx, item: BatchItemResult, raw: unknown): Promise<void> {
  const storyId = item.question.storyId ?? "_run";
  let headsUp: AdviceAuditRecord["headsUp"] = { sent: false, reason: "no-decision" };
  if (item.decision) {
    try {
      headsUp = await deliverHeadsUp(a.actx, item.decision, item.question);
    } catch (err) {
      headsUp = { sent: false, reason: `delivery-failed: ${errorMessage(err)}` };
      getSafeLogger()?.warn("advisor", "Batch heads-up failed — decision stands", {
        storyId,
        decisionId: item.decision.id,
        error: errorMessage(err),
      });
    }
  }
  if (item.decision) logAdvisorDecision(item.decision, headsUp);
  try {
    await auditItem(a, item, raw, headsUp);
  } catch (err) {
    getSafeLogger()?.warn("advisor", "Batch audit failed — decision stands", { storyId, error: errorMessage(err) });
  }
}

function emptyResult(req: BatchRequest, fallbackReason: string): BatchResult {
  return req.kind === "residual"
    ? { kind: "residual", items: [], diagnoses: {}, fallbackReason }
    : { kind: "preflight", items: [], overlap: [], fallbackReason };
}

async function adviseOnce(actx: AdvisorCallContext, req: BatchRequest): Promise<BatchResult> {
  const worktree = await _advisorServiceDeps.captureWorktreePatch(actx.workdir);
  const priorDecisions = await readTrustedDecisions(actx.repoRoot, actx.feature, actx.outputDir);
  const prdText = await _advisorServiceDeps.readPrdText(actx.repoRoot, actx.feature);
  const questions: AdviceQuestion[] =
    req.kind === "residual"
      ? req.items.map((d) => ({ ...d, id: _advisorServiceDeps.newId(), askedAtSha: worktree.sha }))
      : [];
  const input: AdviseBatchOpInput = {
    kind: req.kind,
    summary: req.summary,
    items: questions,
    redGates: req.kind === "residual" ? req.redGates : [],
    storyIds: req.kind === "preflight" ? req.storyIds : [],
    specPath: actx.specPath,
    prdText,
    priorDecisions,
  };
  const prompt = buildAdvisorBatchPrompt(input);
  const costBefore = _advisorServiceDeps.costTotal(actx.callCtx.runtime);
  const run = await runBatchLadder(actx, input);
  const cost = _advisorServiceDeps.costTotal(actx.callCtx.runtime) - costBefore;

  const failure = run.out ? undefined : (run.error ?? "no-output");
  const pending: Pending[] = !run.out
    ? questions.map((question) => ({ question, error: failure, raw: null }))
    : req.kind === "residual"
      ? residualPending(questions, run.out)
      : preflightPending(run.out, req, actx.feature, worktree.sha);
  const items: BatchItemResult[] = [];
  for (const p of pending) items.push(await decide(actx, run, p));
  const a: AuditCtx = { actx, run, prompt, worktree, priorDecisions, costUsd: cost / Math.max(1, items.length) };
  for (const [i, item] of items.entries()) await finishItem(a, item, pending[i]?.raw);
  const fallback = failure ? { fallbackReason: failure } : {};
  return req.kind === "residual"
    ? { kind: "residual", items, diagnoses: run.out?.diagnoses ? { ...run.out.diagnoses } : {}, ...fallback }
    : {
        kind: "preflight",
        items,
        overlap: run.out ? run.out.overlap.map((o) => ({ storyId: o.storyId, specSections: [...o.specSections] })) : [],
        ...fallback,
      };
}

/** Nothing throws: any error becomes a fallback reason on the result and on every residual item (P3-R3). */
export async function adviseBatch(actx: AdvisorCallContext, req: BatchRequest): Promise<BatchResult> {
  try {
    return await adviseOnce(actx, req);
  } catch (err) {
    const fallbackReason = `advisor error: ${errorMessage(err)}`;
    getSafeLogger()?.warn("advisor", "Advisor batch failed — callers keep today's behaviour", {
      storyId: req.kind === "residual" ? req.storyId : "_run",
      kind: req.kind,
      reason: fallbackReason,
    });
    if (req.kind === "preflight") return emptyResult(req, fallbackReason);
    const items = req.items.map((d) => ({
      question: { ...d, id: _advisorServiceDeps.newId(), askedAtSha: "" },
      decision: null,
      fallbackReason,
    }));
    return { kind: "residual", items, diagnoses: {}, fallbackReason };
  }
}
