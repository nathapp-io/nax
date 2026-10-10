/** Read-only worth-check operation for non-blocking-fix findings. */

import { join } from "node:path";
import { previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry/parse-retry";
import { reviewConfigSelector } from "../config";
import type { NbfWorthCheckConfig, ReviewConfig } from "../config/selectors";
import type { Finding } from "../findings";
import { loadPRD, type UserStory } from "../prd";
import { buildNbfWorthCheckPrompt } from "../prompts";
import { collectDiff, collectDiffStat, resolveEffectiveRef, truncateDiff } from "../review/diff-utils";
import { tryParseLLMJson } from "../utils/llm-json";
import { callOp } from "./call";
import { _nbfWorthCheckAuditDeps, recordNbfWorthCheck } from "./nbf-worth-check-audit";
import type { CallContext, Operation, RunOperation } from "./types";

export interface NbfWorthCheckPendingStory {
  readonly id: string;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface NbfWorthCheckOpInput {
  readonly story: UserStory;
  /** Story diff, already truncated by the runner; "" when unavailable. */
  readonly diff: string;
  readonly findings: readonly Finding[];
  readonly pendingStories: readonly NbfWorthCheckPendingStory[];
}

export interface NbfWorthVerdict {
  readonly index: number;
  readonly verdict: "fix" | "skip";
  readonly reason: string;
}

export type NbfWorthCheckOpOutput =
  | { readonly parsed: true; readonly verdicts: readonly NbfWorthVerdict[] }
  | { readonly parsed: false; readonly unparsedPreview: string };

const INVALID_VERDICT_REASON = "(invalid verdict)";
const EMPTY_SKIP_REASON = "(skip without reason)";
const MISSING_VERDICT_REASON = "(no verdict returned)";
const DEFAULT_MODEL = "balanced";
const DEFAULT_TIMEOUT_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unparsedResult(output: string): NbfWorthCheckOpOutput {
  const preview = previewOutput(output, UNPARSED_PREVIEW_BYTES);
  return { parsed: false, unparsedPreview: preview === "" ? "(empty response)" : preview };
}

function normalizeVerdicts(entries: readonly unknown[], findingCount: number): NbfWorthVerdict[] {
  const firstByIndex = new Map<number, Record<string, unknown>>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const index = entry.index;
    if (!Number.isInteger(index) || (index as number) < 1 || (index as number) > findingCount) continue;
    if (!firstByIndex.has(index as number)) firstByIndex.set(index as number, entry);
  }

  return Array.from({ length: findingCount }, (_, offset) => {
    const index = offset + 1;
    const entry = firstByIndex.get(index);
    if (!entry) return { index, verdict: "fix", reason: MISSING_VERDICT_REASON };
    if (entry.verdict !== "fix" && entry.verdict !== "skip") {
      return { index, verdict: "fix", reason: INVALID_VERDICT_REASON };
    }
    if (entry.verdict === "skip") {
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      if (reason.trim() === "") return { index, verdict: "fix", reason: EMPTY_SKIP_REASON };
      return { index, verdict: "skip", reason };
    }
    return { index, verdict: "fix", reason: typeof entry.reason === "string" ? entry.reason : "" };
  });
}

export function parseNbfWorthReply(output: string, findingCount: number): NbfWorthCheckOpOutput {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.verdicts)) return unparsedResult(output);
  return { parsed: true, verdicts: normalizeVerdicts(parsed.verdicts, findingCount) };
}

export const nbfWorthCheckOp: RunOperation<NbfWorthCheckOpInput, NbfWorthCheckOpOutput, ReviewConfig> = {
  kind: "run",
  name: "nbf-worth-check",
  stage: "review",
  session: { role: "nbf-worth-check", lifetime: "fresh" },
  tools: ["Read", "Glob", "Grep"],
  config: reviewConfigSelector,
  model: (_input, ctx) => ctx.config.review.nonBlockingFix?.worthCheck?.model ?? DEFAULT_MODEL,
  timeoutMs: (_input, ctx) => ctx.config.review.nonBlockingFix?.worthCheck?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildNbfWorthCheckPrompt(input), overridable: false },
  }),
  parse: (output, input) => parseNbfWorthReply(output, input.findings.length),
};

export interface NbfWorthCheckRequest {
  readonly ctx: CallContext;
  readonly findings: readonly Finding[];
  readonly cfg: NbfWorthCheckConfig | undefined;
}

export const _nbfWorthCheckDeps = {
  callOp: callOp as <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I) => Promise<O>,
  resolveEffectiveRef,
  collectDiff,
  collectDiffStat,
  loadPRD,
};

async function storyDiff(ctx: CallContext): Promise<string> {
  try {
    const ref = await _nbfWorthCheckDeps.resolveEffectiveRef(ctx.packageDir, ctx.story?.storyGitRef, ctx.storyId ?? "");
    if (!ref) return "";
    const [diff, stat] = await Promise.all([
      _nbfWorthCheckDeps.collectDiff(ctx.packageDir, ref, []),
      _nbfWorthCheckDeps.collectDiffStat(ctx.packageDir, ref),
    ]);
    return diff === null ? "" : truncateDiff(diff, stat);
  } catch {
    return "";
  }
}

async function pendingFeatureStories(ctx: CallContext): Promise<NbfWorthCheckPendingStory[]> {
  if (!ctx.featureDir) return [];
  try {
    const prd = await _nbfWorthCheckDeps.loadPRD(join(ctx.featureDir, "prd.json"));
    return prd.userStories
      .filter((story) => story.id !== ctx.story?.id && ["pending", "in-progress", "paused"].includes(story.status))
      .map(({ id, title, acceptanceCriteria }) => ({ id, title, acceptanceCriteria }));
  } catch {
    return [];
  }
}

export async function runNbfWorthCheck(req: NbfWorthCheckRequest): Promise<Finding[]> {
  const seed = [...req.findings];
  if (!req.cfg || req.cfg.mode === "off" || !req.ctx.story || seed.length === 0) return seed;
  const startedAt = _nbfWorthCheckAuditDeps.now();
  const costBefore = _nbfWorthCheckAuditDeps.costTotal(req.ctx.runtime);
  let result: NbfWorthCheckOpOutput | undefined;
  let failure: string | undefined;
  try {
    const input: NbfWorthCheckOpInput = {
      story: req.ctx.story,
      diff: await storyDiff(req.ctx),
      findings: seed,
      pendingStories: await pendingFeatureStories(req.ctx),
    };
    const output: unknown = await _nbfWorthCheckDeps.callOp(req.ctx, nbfWorthCheckOp, input);
    result = isWorthOutput(output) ? output : { parsed: false, unparsedPreview: "unparseable worth-check reply" };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await recordNbfWorthCheck({
    runtime: req.ctx.runtime,
    storyId: req.ctx.story.id,
    featureName: req.ctx.featureName,
    packageDir: req.ctx.packageDir,
    mode: req.cfg.mode,
    findings: seed,
    ...(result ? { result } : {}),
    ...(failure !== undefined ? { error: failure } : {}),
    durationMs: _nbfWorthCheckAuditDeps.now() - startedAt,
    costUsd: _nbfWorthCheckAuditDeps.costTotal(req.ctx.runtime) - costBefore,
  });
  if (req.cfg.mode !== "on" || failure !== undefined || !result || !result.parsed) return seed;
  return seed.filter((_, index) =>
    result.verdicts.some((verdict) => verdict.index === index + 1 && verdict.verdict === "fix"),
  );
}

function isWorthOutput(value: unknown): value is NbfWorthCheckOpOutput {
  return (
    isParsedWorthOutput(value) ||
    (typeof value === "object" &&
      value !== null &&
      "parsed" in value &&
      value.parsed === false &&
      "unparsedPreview" in value &&
      typeof value.unparsedPreview === "string")
  );
}

function isParsedWorthOutput(value: unknown): value is Extract<NbfWorthCheckOpOutput, { parsed: true }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "parsed" in value &&
    value.parsed === true &&
    "verdicts" in value &&
    Array.isArray(value.verdicts)
  );
}
