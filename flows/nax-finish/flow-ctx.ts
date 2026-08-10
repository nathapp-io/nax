/**
 * Readers over an acpx `FlowNodeContext` — the flow graph's view of its own
 * state.
 *
 * Split out of `nax-finish.flow.ts` (600-line source cap). These are all pure
 * functions of `ctx.input` / `ctx.outputs` / `ctx.state.steps`; anything that
 * shells out lives under `./steps/`.
 *
 * Two views of the same run, and the difference matters in a graph whose whole
 * shape is loops:
 *
 * - `ctx.outputs` is a map keyed by node id, so it holds only each node's
 *   **latest** output. A node re-entering a loop cannot see its own previous
 *   round there.
 * - `ctx.state.steps` is the ordered history and carries every step's `output`,
 *   so an earlier round IS recoverable from it. A step is appended on its
 *   *outcome*, so the currently-executing node is never in this list — which is
 *   what lets `incrementalSince` find the *previous* review rather than itself.
 */
import type { AcceptanceStatus } from "./steps/context";
import type { AcceptanceGroup, Finding, FinishInput, FinishPhase, ReviewVerdict } from "./types";

/** Minimal shapes so each reader takes only the part of the context it reads. */
export interface StepsCtx {
  state: { steps: { nodeId: string; output?: unknown }[] };
}
export interface OutputsCtx {
  outputs: unknown;
}

export const inputOf = (ctx: { input: unknown }) => ctx.input as FinishInput;

/** What `load_ctx` resolves once, for every downstream node to read. */
export interface LoadCtxOutput {
  base?: string;
  specPath?: string;
  groups?: AcceptanceGroup[];
  /** `nax features resolve`'s acceptance status, narrowed at `resolveFeature`. */
  acceptanceStatus?: AcceptanceStatus;
  /** Test-file regex sources from `nax features resolve`; empty = cannot classify. */
  testFileRegex?: string[];
  route?: string;
  /** Set only when `route` is `escalate` — see `preflight`. */
  reason?: string;
}

export function fixAttemptCount(ctx: StepsCtx, fixNodeId: string): number {
  return (ctx.state.steps ?? []).filter((s) => s.nodeId === fixNodeId).length;
}

export function loadCtxOf(ctx: OutputsCtx): LoadCtxOutput {
  return ((ctx.outputs as Record<string, LoadCtxOutput | undefined>).load_ctx ?? {}) as LoadCtxOutput;
}
/**
 * The narrative node's parsed prose.
 *
 * Absent when the node was skipped by config, died, or produced only
 * whitespace — `amend_body` treats all three identically, so there is one
 * branch downstream rather than three.
 *
 * Accepts the bare string the node used to return as well as the
 * `{ narrative, title }` it returns now: a flow resumed from a run recorded
 * before the title landed replays the old shape from its journal.
 */
export function narrativeOf(ctx: OutputsCtx): string | undefined {
  const out = (ctx.outputs as Record<string, unknown>).narrative;
  const prose = typeof out === "string" ? out : (out as { narrative?: unknown } | undefined)?.narrative;
  return typeof prose === "string" && prose.trim().length > 0 ? prose : undefined;
}

/**
 * The narrative node's parsed PR title, already sanitised by `parseTitle`.
 *
 * Absent whenever the node is — `resolveTitle` then falls back to
 * `feat: <feature>`, which is what shipped before and what auto-PR opens with.
 */
export function prTitleOf(ctx: OutputsCtx): string | undefined {
  const out = (ctx.outputs as Record<string, unknown>).narrative;
  if (typeof out !== "object" || out === null) return undefined;
  const title = (out as { title?: unknown }).title;
  return typeof title === "string" && title.trim().length > 0 ? title : undefined;
}

export function gateOutputs(ctx: OutputsCtx): { failing?: string[]; ran?: string[] } {
  return ((ctx.outputs as Record<string, { failing?: string[]; ran?: string[] } | undefined>).quality_gates ?? {}) as {
    failing?: string[];
    ran?: string[];
  };
}

/** The findings the `fix_<phase>` node was asked to resolve; empty for non-review phases. */
export function findingsOf(ctx: OutputsCtx, phase: FinishPhase): Finding[] {
  if (phase !== "spec" && phase !== "quality") return [];
  return (ctx.outputs as Record<string, ReviewVerdict | undefined>)[`review_${phase}`]?.findings ?? [];
}

/**
 * The ref a re-review should diff from, or null to review the whole branch.
 *
 * A reviewer node re-reads the spec in full and the entire `git diff
 * base...HEAD` on every round. Reviews were 58% of the wall clock on
 * rs-stock/pipeline-run-outcome (7 calls, 1306s of 2232s), and round 3 re-read
 * everything rounds 1-2 had already cleared.
 *
 * The scoping ref is the `shaBefore` of the **first** `commit_*` step after this
 * phase's last review — that commit's parent is, by construction, the tree the
 * previous verdict passed on, since only `commit_*` nodes commit. Taking the
 * first (not the last) is what makes the window complete when more than one
 * commit landed in it, which happens when the acceptance loop commits between a
 * spec fix and its re-review: `firstCommit.shaBefore..HEAD` spans both.
 *
 * Read from `ctx.state.steps[].output`, not `ctx.outputs` — the latter keeps
 * only each node's newest output, which for two commit steps of the same node id
 * would have discarded the earlier `shaBefore` and silently under-scoped the
 * review.
 *
 * Only commit steps that actually **committed** anchor the window. A fix node
 * that edited nothing still records a `commit_*` step, and its `shaBefore` is
 * the current HEAD — so scoping to it asks the reviewer for `HEAD..HEAD`, an
 * empty diff, while the prompt tells it the prior findings "have since been
 * fixed and committed". It returns clean, `route_*` sends the flow onward, and
 * the findings ship unfixed. That leaves the loop through the green door, so
 * `MAX_FIX_ATTEMPTS` never catches it. A no-op round therefore either yields
 * the window to a later real commit, or falls back to a full review.
 *
 * Rounds journalled before `committed` existed carry no such field; `!== false`
 * keeps replaying them on the previous behaviour rather than widening every
 * resumed review to the whole branch.
 *
 * Returns null — a full review — when there is no prior review of this phase
 * (round 1), no commit landed since it (nothing new to look at), or the commit
 * step recorded no `shaBefore`.
 */
export function incrementalSince(ctx: OutputsCtx & StepsCtx, phase: "spec" | "quality"): string | null {
  const steps = ctx.state.steps ?? [];
  const lastReview = steps.map((s) => s.nodeId).lastIndexOf(`review_${phase}`);
  if (lastReview < 0) return null;
  const firstCommit = steps
    .slice(lastReview + 1)
    .find(
      (s) => s.nodeId.startsWith("commit_") && (s.output as { committed?: boolean } | undefined)?.committed !== false,
    );
  if (!firstCommit) return null;
  return (firstCommit.output as { shaBefore?: string | null } | undefined)?.shaBefore ?? null;
}
