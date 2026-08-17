/**
 * Turning a reviewer's reply into a deterministic route.
 *
 * Lives outside `nax-finish.flow.ts` for two reasons: the flow file sits within
 * a few lines of the 600-line hard limit, and this is a cohesive unit —
 * `routeReview` consumes exactly what the parsers produce.
 *
 * The central invariant: **no parser here ever throws.** acpx has no node-level
 * retry and no error edge (`AcpNodeDefinition` offers only `prompt`/`parse`;
 * `FlowEdge` is only `to` or `switch`), so a throw inside `parse` fails the node
 * and fails the run — exit 1, no result file, no notification, bypassing the
 * `escalate` node that exists to report precisely this.
 */
import { extractJsonObject } from "acpx/flows";
import { parseReviewReport } from "./findings-parse";
import { type OutputsCtx, type StepsCtx, fixAttemptCount } from "./flow-ctx";
import type { Finding, ReviewVerdict } from "./types";

/**
 * Cap on fix-and-reverify iterations, per phase, before escalating instead of
 * looping forever. acpx's flow engine has no built-in cycle guard, so without
 * this cap a stubborn failure (LLM can't fix it, or fixes something else each
 * time) hangs `acpx flow run` — and the post-run plugin awaits that subprocess.
 *
 * Lives here rather than in the flow file because `routeReview` needs it; the
 * flow imports it back for the acceptance node and the two `quality_gates` caps.
 */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * Unparseable reviews tolerated per phase before escalating.
 *
 * One. A reviewer that ignores the JSON contract twice in a row is not going to
 * comply on a third ask, and each review is the most expensive node in the flow
 * (128s and ~4.2M tokens on the run that motivated this).
 */
export const MAX_REPROMPT_ATTEMPTS = 1;

/**
 * Reviews sent back for missing evidence sections, per phase, before escalating.
 *
 * One, for the same reason `MAX_REPROMPT_ATTEMPTS` is one: a reviewer that
 * ignores the reply contract twice is not going to honour it on a third ask, and
 * a review is the most expensive node in the flow.
 */
export const MAX_INCOMPLETE_ATTEMPTS = 1;

/** How much of an unparseable reply to carry forward — it lands in a PR comment and a Telegram message. */
export const RAW_TAIL_LIMIT = 500;

function tail(text: string): string {
  const t = text.trim();
  return t.length <= RAW_TAIL_LIMIT ? t : `…${t.slice(-(RAW_TAIL_LIMIT - 1))}`;
}

/** Shared happy path: read the object, normalise findings, rewrite empty `proceed` to `clean`. */
function parseVerdictJson(text: string): ReviewVerdict {
  const raw = extractJsonObject(text) as Partial<ReviewVerdict>;
  const findings: Finding[] = Array.isArray(raw.findings) ? raw.findings : [];
  const route = raw.route === "escalate" ? "escalate" : findings.length === 0 ? "clean" : "proceed";
  return { route, findings, escalationReason: raw.escalationReason };
}

/**
 * Read a reviewer's reply, block format first.
 *
 * Three tiers, in cost order: the block contract the prompt asks for; then the
 * JSON object older runs produced (a flow resumed from a journal recorded before
 * #1614, or a reviewer that answered in the old shape anyway); then reprompt.
 * The JSON tier is three lines and removes a whole class of resume failure, so
 * it stays even though nothing asks for JSON any more.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const report = parseReviewReport(text);
  if (report.findings.length > 0 || report.sawNoFindings) {
    const judged = report.findings.find((f) => f.judgment);
    const route = judged ? "escalate" : report.findings.length === 0 ? "clean" : "proceed";
    return {
      route,
      findings: report.findings,
      ...(judged ? { escalationReason: judged.judgmentReason ?? `Needs human judgment: ${judged.title}` } : {}),
      touchpoints: report.touchpoints,
      walk: report.walk,
      sawTouchpointsSection: report.sawTouchpointsSection,
      sawWalkSection: report.sawWalkSection,
    };
  }
  try {
    return parseVerdictJson(text);
  } catch {
    return { route: "reprompt", findings: [], raw: tail(text) };
  }
}

/**
 * Parser for the four `fix_*` nodes, whose parsed value nothing reads —
 * `findingsOf` only ever looks at `review_spec`/`review_quality`, and
 * `commitFixNode` decides from git rather than from the model's word.
 *
 * Never routes `reprompt`: the fix nodes have unconditional edges
 * (`fix_spec → commit_spec`), so a reprompt route would have nowhere to go.
 */
export function parseFixVerdict(text: string): ReviewVerdict {
  try {
    return parseVerdictJson(text);
  } catch {
    return { route: "proceed", findings: [] };
  }
}

/**
 * How many times this phase's review already came back unparseable.
 *
 * Counts step *outputs*, not step ids: `commit_quality → review_quality` and
 * `commit_gate → review_quality` are legitimate re-entries in the normal fix
 * loop, so counting bare `review_<phase>` steps would escalate a healthy run.
 *
 * This is observable only because `parseReviewVerdict` returns rather than
 * throws — a returned verdict makes acpx record the step as successful with
 * this output. A throw would record it `failed`, with nothing to count.
 *
 * SELF-INCLUSIVE, not self-exclusive: acpx's runtime calls
 * `recordFlowStepOutcome(runDir, state, step)` (acpx/src/flows/runtime.ts:262),
 * which pushes the just-finished step onto `state.steps`
 * (acpx/src/flows/runtime.ts:499), BEFORE `resolveNextNode` runs and before the
 * following node (`route_<phase>`) executes. So by the time `routeReview` reads
 * `ctx.state.steps` here, the current round's own `review_<phase>` step is
 * already included. On the very first unparseable reply this already returns
 * 1, not 0. `routeReview`'s comparison against `MAX_REPROMPT_ATTEMPTS` MUST
 * stay `<=` (not `<`) for that reason — see routeReview below.
 */
export function repromptCount(ctx: StepsCtx, phase: "spec" | "quality"): number {
  return (ctx.state.steps ?? []).filter(
    (s) => s.nodeId === `review_${phase}` && (s.output as ReviewVerdict | undefined)?.route === "reprompt",
  ).length;
}

/**
 * Turn a reviewer verdict into a deterministic route.
 *
 * `clean` (no findings) skips the fix node entirely — prompting an agent to
 * "apply the recommended fixes" for an empty finding list burns a turn and
 * invites unrequested edits.
 *
 * The `reprompt` branch MUST come first. A reprompt verdict carries zero
 * findings, so checking `findings.length === 0` ahead of it would route an
 * unreadable review to `clean`, and the flow would open a PR having reviewed
 * nothing. That silent false green is worse than the crash this replaces.
 *
 * An **absent** verdict escalates for the same reason, and it is a distinct
 * case from an unparseable one: `parseReviewVerdict` never returns undefined,
 * so a missing entry means the node produced no output at all — it never ran,
 * or it died before emitting. Neither is an approval. This must not fall
 * through to `findings ?? []`, because `ctx.outputs` holds only each node's
 * latest output: on a loop re-entry the previous round's clean verdict can
 * still be sitting there, and routing on it re-approves a diff nobody read.
 * There is no reprompt path here — a node that emitted nothing has no raw tail
 * to quote back, so a human is the only remaining reader.
 */
export function routeReview(
  ctx: OutputsCtx & StepsCtx,
  phase: "spec" | "quality",
): { route: string; escalationReason?: string; findings: Finding[] } {
  const verdict = (ctx.outputs as Record<string, ReviewVerdict | undefined>)[`review_${phase}`];
  if (!verdict) {
    return {
      route: "escalate",
      escalationReason: `${phase} reviewer produced no verdict — the node emitted no output, so nothing reviewed this diff.`,
      findings: [],
    };
  }
  const findings = verdict.findings ?? [];
  if (verdict.route === "reprompt") {
    // `attempts` is self-inclusive (see repromptCount) — it already counts this
    // round's failure, so `<=` (not `<`) is what makes MAX_REPROMPT_ATTEMPTS=1
    // tolerate exactly one retry before escalating.
    const attempts = repromptCount(ctx, phase);
    if (attempts <= MAX_REPROMPT_ATTEMPTS) return { route: "reprompt", findings };
    return {
      route: "escalate",
      escalationReason:
        `${phase} reviewer returned unparseable output after ${attempts} attempts. ` +
        `Last reply: ${verdict.raw ?? "(empty)"}`,
      findings,
    };
  }
  if (verdict.route === "escalate") {
    return {
      route: "escalate",
      escalationReason: verdict.escalationReason ?? `${phase} review raised a finding needing human judgment`,
      findings,
    };
  }
  if (findings.length === 0) return { route: "clean", findings };
  const attempts = fixAttemptCount(ctx, `fix_${phase}`);
  if (attempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      escalationReason: `${phase} review still reporting ${findings.length} finding(s) after ${attempts} fix attempts.`,
      findings,
    };
  }
  return { route: "fix", findings };
}
