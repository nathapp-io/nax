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
  /** `nax features resolve`'s acceptance status: "ok" | "disabled" | "no-prd". */
  acceptanceStatus?: string;
  /** Test-file regex sources from `nax features resolve`; empty = cannot classify. */
  testFileRegex?: string[];
  route?: string;
}

export function fixAttemptCount(ctx: StepsCtx, fixNodeId: string): number {
  return (ctx.state.steps ?? []).filter((s) => s.nodeId === fixNodeId).length;
}

export function loadCtxOf(ctx: OutputsCtx): LoadCtxOutput {
  return ((ctx.outputs as Record<string, LoadCtxOutput | undefined>).load_ctx ?? {}) as LoadCtxOutput;
}

export function gateOutputs(ctx: OutputsCtx): { failing?: string[] } {
  return ((ctx.outputs as Record<string, { failing?: string[] } | undefined>).quality_gates ?? {}) as {
    failing?: string[];
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
 * Returns null — a full review — when there is no prior review of this phase
 * (round 1), no commit since it (nothing new to look at), or the commit step
 * recorded no `shaBefore`.
 */
export function incrementalSince(ctx: OutputsCtx & StepsCtx, phase: "spec" | "quality"): string | null {
  const steps = ctx.state.steps ?? [];
  const lastReview = steps.map((s) => s.nodeId).lastIndexOf(`review_${phase}`);
  if (lastReview < 0) return null;
  const firstCommit = steps.slice(lastReview + 1).find((s) => s.nodeId.startsWith("commit_"));
  if (!firstCommit) return null;
  return (firstCommit.output as { shaBefore?: string | null } | undefined)?.shaBefore ?? null;
}
