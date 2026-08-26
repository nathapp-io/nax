/**
 * The phase-parameterised finish review operation.
 *
 * One `RunOperation` drives both the spec and quality reviewer phases, since
 * `buildReviewPrompt` / `parseReviewReport` / `auditGaps` are already
 * phase-agnostic (the caller supplies `phase` on the input). What differs
 * between phases is the *session role* the reply lands under — and
 * `session.role` on a `RunOperation` is a static field, not a per-input
 * resolver (see `src/operations/types.ts`). There is deliberately no
 * `session: { role: (input) => ... }` here; that shape does not exist on the
 * type, and adding a resolver field to accommodate it would be inventing API
 * surface the rest of the op framework does not have.
 *
 * The static `session.role` below (`"finish-review-spec"`) is only ever the
 * *default* — the caller selects the real per-phase role by passing
 * `CallContext.sessionOverride.role: "finish-review-spec" | "finish-review-quality"`
 * into `callOp`, exactly as `src/plan/critic.ts` runs `planDraftOp` under a
 * `plan-revise` override. `callOp` honours the override at
 * `ctx.sessionOverride?.role ?? runOp.session.role` (`src/operations/call.ts`).
 * Do not "fix" this into a resolver — the type does not allow it, and the
 * override is the sanctioned mechanism.
 */
import { makeParseRetryStrategy } from "@/agents/retry";
import type { ConfiguredModel } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import { auditGaps, buildReviewPrompt, parseReviewReport } from "../finish/review";
import type { Finding, ReviewReport } from "../finish/types";
import type { RunOperation, RunOperationWithHooks } from "./types";

export interface FinishReviewInput {
  phase: "spec" | "quality";
  base: string;
  specPath: string;
  workdir: string;
  since?: string;
  priorFindings?: Finding[];
  gaps?: string[];
  /** Reviewer selection, resolved by the caller from config (D3.6). */
  model?: ConfiguredModel;
  timeoutMs?: number;
}

/**
 * `ReviewOutcome` (`{ findings, gaps }`) is structurally a subset of this —
 * `routeReview` (already shipped) consumes `{ findings, gaps }` directly, so
 * the caller needs no adapter between this op's output and the router.
 */
export type FinishReviewOutput = ReviewReport & { gaps: string[] };

/**
 * The gap the exhausted-retry fallback carries.
 *
 * Load-bearing, not decorative. `callOp` returns a captured `exhaustedFallback`
 * directly — its `!rawOutput` branch and its parse-failure branch both `return`
 * without going through `runPostParse`, which is the only caller of
 * `op.verify`. `verify` is where this op's `gaps` normally come from
 * (`auditGaps`), so on the exhausted path it never runs. A fallback with an
 * empty `gaps` array therefore reaches `routeReview` as
 * `{findings: [], gaps: []}` and routes **clean**: a reviewer that produced
 * nothing at all would be recorded as a passing review and the PR promoted on
 * the strength of it. Carrying the gap here is what makes `routeReview` treat
 * it as no verdict — one re-review, then escalate — which is the behaviour the
 * acpx flow had when its reprompt budget ran out.
 */
const NO_REPLY_GAP =
  "the reviewer produced no usable reply after every retry — no `## TOUCHPOINTS`, `## WALK` or `## FINDINGS` section was received, so nothing reviewed this diff";

const EMPTY_REVIEW_REPORT: FinishReviewOutput = {
  findings: [],
  touchpoints: [],
  walk: [],
  sawNoFindings: false,
  sawTouchpointsSection: false,
  sawWalkSection: false,
  gaps: [NO_REPLY_GAP],
};

const FINDING_BLOCK_START = /^\s*\[(CRITICAL|HIGH|MEDIUM|LOW)\]/;
const FIX_FIELD = /^\s*Fix\s*:/i;

/**
 * The reviewer's reply is free text, not JSON — `looksLikeTruncatedJson` (the
 * default `looksTruncated`) is meaningless here and would classify every
 * reply by a JSON heuristic that never matches. This predicate instead looks
 * for the one truncation signature this contract can actually exhibit: a
 * `[SEVERITY]` finding block opened with no `Fix:` line ever following it
 * before the reply ends.
 */
function looksLikeTruncatedReviewReply(output: string): boolean {
  const lines = output.split("\n");
  let lastBlockLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FINDING_BLOCK_START.test(lines[i])) lastBlockLine = i;
  }
  if (lastBlockLine === -1) return false;
  return !lines.slice(lastBlockLine + 1).some((line) => FIX_FIELD.test(line));
}

/**
 * "Did this reply produce a verdict?" — the same distinction `routeReview`
 * needs downstream: findings, or the explicit `No findings.` marker, count as
 * a review having happened. Anything else (empty narration, a reply that
 * never reached its FINDINGS section) is not a verdict and should be retried.
 */
function isReviewVerdict(report: ReviewReport): boolean {
  return report.findings.length > 0 || report.sawNoFindings;
}

const INVALID_PROMPT = [
  "Your reply did not follow the required contract. It must be exactly three",
  "sections, in this order: `## TOUCHPOINTS`, `## WALK`, `## FINDINGS`.",
  "Re-send your full reply in that shape now.",
].join("\n");

const TRUNCATED_PROMPT = [
  "Your reply was cut off partway through a finding. Re-send just the",
  "`## FINDINGS` section, complete, starting from the beginning of that",
  "section — one `[SEVERITY] Title` block per finding, each with `Problem:`",
  "and `Fix:` lines, or the literal line `No findings.` if there are none.",
].join("\n");

export const finishReviewOp: RunOperationWithHooks<FinishReviewInput, FinishReviewOutput, FinishConfig, "verify"> = {
  kind: "run",
  name: "finish-review",
  stage: "review",
  config: finishConfigSelector,
  // Default only — see the module doc comment. The caller selects the real
  // per-phase role via CallContext.sessionOverride.role.
  session: { role: "finish-review-spec", lifetime: "fresh" },
  model: (input) => input.model,
  // `finish.timeouts.stepMs` when set, otherwise the run's own session timeout.
  // Not left undefined: `callOp` does fall back to `execution.sessionTimeoutSeconds`
  // for run-kind ops, but that is a branch inside `callOp` that nothing pins for
  // these ops, and complete-kind ops get no such fallback at all. Resolving it
  // here makes the bound explicit and matches the acceptance ops.
  timeoutMs: (input, ctx) => input.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const content = buildReviewPrompt(input.phase, {
      base: input.base,
      specPath: input.specPath,
      since: input.since,
      priorFindings: input.priorFindings,
      gaps: input.gaps,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  // Never throws (D3.4) — parseReviewReport is pure and non-throwing, so an
  // unreadable reply degrades to an empty-but-valid report, not a failure.
  parse(output, _input, _ctx) {
    return { ...parseReviewReport(output), gaps: [] };
  },
  retry: makeParseRetryStrategy({
    parse: (output) => parseReviewReport(output),
    validate: (parsed) => isReviewVerdict(parsed as ReviewReport),
    looksTruncated: looksLikeTruncatedReviewReply,
    reviewerKind: "finish-review",
    maxAttempts: 2,
    prompts: {
      invalid: () => INVALID_PROMPT,
      truncated: () => TRUNCATED_PROMPT,
    },
    // Degrade to "no verdict", not a throw. The verdict-ness lives in
    // EMPTY_REVIEW_REPORT's `gaps` (see NO_REPLY_GAP): callOp returns this
    // object without ever calling op.verify, so it must arrive at routeReview
    // already un-routable as clean. parseReviewReport never throws, so the
    // live trigger is genuinely empty output — an unreadable-but-present reply
    // is handled by parse() returning an empty-but-valid report, which does
    // get its gaps from verify.
    exhaustedFallback: () => EMPTY_REVIEW_REPORT,
  }),
  // verify is the sanctioned disk-consulting hook (ADR-020 §D4); a non-null
  // return wins over parse's result. Must never return null here — that
  // would fall through and silently skip the gap check.
  //
  // US-002: threads the review range (`base`..`head`) and `phase` through to
  // auditGaps so the quality phase can gate the WALK against the changed-file
  // list (`git diff <base>...HEAD`) while the spec phase keeps its shape-only
  // checks. AC15 pins that the spawned git command carries the review range.
  async verify(parsed, input, _verifyCtx) {
    return {
      ...parsed,
      gaps: await auditGaps(parsed, input.workdir, { base: input.base, head: "HEAD" }, input.phase),
    };
  },
};
