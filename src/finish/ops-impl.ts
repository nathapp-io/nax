/**
 * The concrete `FinishOps` the state machine runs against.
 *
 * A factory rather than a module of free functions: every method needs the
 * same closed-over `CallContext`, forge deps and model selections, and the
 * machine's contract (`./ops`) is an object. Two of the contract's clauses are
 * load-bearing and are implemented here, not in the modules below:
 *
 * - `escalate` must not throw. Its whole body is wrapped, and a delivery
 *   failure is returned as `deliveryError` — `machine.ts`'s `doEscalate` is
 *   the only caller and it has no other way to record that the human was
 *   never told.
 * - `narrate` must not throw. The machine calls it *after* `promotePr`,
 *   inside its one try, so a throw rewrites an already-promoted green run to
 *   `escalated`.
 *
 * `review` and `fix` deliberately do neither: a reviewer or fixer that cannot
 * run is exactly the case the machine's catch exists for.
 */
import type { ConfiguredModel } from "@/config";
import type { ForgeDeps, ForgeKind } from "@/forge";
import { callOp, finishFixOp, finishNarrativeOp, finishReviewOp } from "@/operations";
import type { CallContext, FinishFixInput, FinishNarrativeInput, FinishReviewInput } from "@/operations";
import { errorMessage } from "../utils/errors";
import type { AuditTarget } from "./audit";
import { commitAndPush } from "./commit";
import { buildEscalationComment, postEscalation } from "./escalate";
import type { FinishOps, FixRequest, ReviewRequest } from "./ops";
import {
  buildFinishBody,
  buildFinishTitle,
  loadFinishPrContext,
  openDraftFinishPr,
  openOrPromotePr,
  updatePrBody,
} from "./pr";
import type { FinishState } from "./state";
import type { FinishPrBodySettings } from "./types";
import type { Finding, FinishPhase } from "./types";

export interface FinishOpsDeps {
  /** The call context every LLM op runs under. Its `sessionOverride` is replaced per phase. */
  callCtx: CallContext;
  /** Subprocess and file I/O for every forge call. */
  forge: ForgeDeps;
  /** Resolved once by the caller; null disables every forge interaction. */
  forgeKind: ForgeKind | null;
  audit: AuditTarget;
  /** Per-step model selection. Absent falls through to callOp's own default. */
  models?: {
    reviewSpec?: ConfiguredModel;
    reviewQuality?: ConfiguredModel;
    fix?: ConfiguredModel;
    narrative?: ConfiguredModel;
  };
  timeouts?: { reviewMs?: number; fixMs?: number; narrativeMs?: number };
  /** The existing `FinishPrBodySettings` from `./types` (D4.8). */
  prBody?: FinishPrBodySettings;
  /** Telegram is the sole escalation channel when true. */
  preferTelegram?: boolean;
  /** Narrative is opt-out: when false, `narrate` is omitted from the returned object. */
  narrative?: boolean;
  warn?: (message: string, details: Record<string, unknown>) => void;
}

export const _finishOpsDeps: { callOp: typeof callOp } = { callOp };

/** The commit the promote path pushes before touching the forge (matches the flow, line 344). */
const PROMOTE_MESSAGE = (feature: string): string => `fix(${feature}): nax-finish automated fixes`;

/** The commit the escalate path pushes so the escalation describes state a human can see (flow line 441). */
const ESCALATION_PUSH_MESSAGE = (feature: string): string =>
  `wip(${feature}): nax-finish partial fixes before escalation`;

/**
 * Load the PR context and render it, falling back to a minimal title/body on
 * any failure rather than propagating.
 *
 * `loadFinishPrContext` is itself fail-open per artifact, but the pure
 * renderers (`buildFinishTitle` / `buildFinishBody`) are not guarded, and a
 * throw here must not undo work `promotePr`'s already-fatal push just did —
 * the branch is pushed and the gates are green by the time this runs, so
 * losing that to an unrenderable PR body would be strictly worse than a
 * generic one.
 */
async function buildPrContentOrFallback(
  state: FinishState,
  audit: AuditTarget,
  forgeKind: ForgeKind,
  prBody: FinishPrBodySettings | undefined,
): Promise<{ title: string; body: string }> {
  try {
    const ctx = await loadFinishPrContext({ state, audit, forge: forgeKind, prBody });
    return { title: buildFinishTitle(ctx), body: buildFinishBody(ctx) };
  } catch (err) {
    return {
      title: `fix(${state.feature}): nax-finish automated fixes`,
      body: `PR body could not be generated: ${errorMessage(err)}`,
    };
  }
}

export function createFinishOps(deps: FinishOpsDeps): FinishOps {
  const { callCtx, forge, forgeKind, audit, models, timeouts, prBody, preferTelegram, warn } = deps;

  const ops: FinishOps = {
    async review(phase: "spec" | "quality", req: ReviewRequest) {
      const { state } = req;
      const phaseState = state.phases[phase];
      const input: FinishReviewInput = {
        phase,
        base: state.base,
        specPath: state.specPath,
        workdir: state.workdir,
        since: phaseState.reviewSince,
        gaps: phaseState.reviewGaps,
        priorFindings: state.findings,
        model: phase === "spec" ? models?.reviewSpec : models?.reviewQuality,
        timeoutMs: timeouts?.reviewMs,
      };
      return _finishOpsDeps.callOp(
        {
          ...callCtx,
          sessionOverride: { role: phase === "spec" ? "finish-review-spec" : "finish-review-quality" },
        },
        finishReviewOp,
        input,
      );
    },

    async fix(phase: FinishPhase, req: FixRequest) {
      const { state, findings, failing, gateOutput, acceptanceOutput } = req;
      const input: FinishFixInput = {
        phase,
        workdir: state.workdir,
        findings,
        failing,
        gateOutput,
        acceptanceOutput,
        model: models?.fix,
        timeoutMs: timeouts?.fixMs,
      };
      // Not `callCtx` alone — an explicit `sessionOverride: undefined` makes sure a
      // context the caller built with one set (e.g. for a review call reused here)
      // doesn't leak a reviewer role into the fixer once a caller starts wiring one in.
      return _finishOpsDeps.callOp({ ...callCtx, sessionOverride: undefined }, finishFixOp, input);
    },

    async openDraftPr(state: FinishState) {
      if (forgeKind === null) return null;
      // A context-load or render failure here must not surface as a throw: the
      // draft is a convenience (D4.5) and the safe response to any failure in
      // producing its content is the same as to any failure opening it — skip.
      let content: { title: string; body: string };
      try {
        const ctx = await loadFinishPrContext({ state, audit, forge: forgeKind, prBody });
        content = { title: buildFinishTitle(ctx), body: buildFinishBody(ctx) };
      } catch {
        return null;
      }
      return openDraftFinishPr(
        { workdir: state.workdir, branch: state.branch, title: content.title, body: content.body, forge: forgeKind },
        forge,
      );
    },

    async promotePr(state: FinishState) {
      await commitAndPush(state.workdir, state.branch, PROMOTE_MESSAGE(state.feature));
      if (forgeKind === null) return { status: "already-ready" };
      const content = await buildPrContentOrFallback(state, audit, forgeKind, prBody);
      return openOrPromotePr(
        { workdir: state.workdir, branch: state.branch, title: content.title, body: content.body, forge: forgeKind },
        forge,
      );
    },

    async escalate(state: FinishState, reason: string, findings: Finding[]) {
      let pushError: string | undefined;
      try {
        await commitAndPush(state.workdir, state.branch, ESCALATION_PUSH_MESSAGE(state.feature));
      } catch (err) {
        pushError = errorMessage(err);
      }
      const syncNote = pushError ? `\n\n> Note: nax-finish could not push its partial fixes — ${pushError}` : "";
      try {
        if (forgeKind === null) {
          // The push failure would otherwise be lost here — this is the one
          // branch that never reaches `buildEscalationComment`, so it has to
          // carry `pushError` itself rather than via `syncNote`.
          return {
            deliveryError: pushError
              ? `no forge detected; partial fixes could not be pushed either: ${pushError}`
              : "no forge detected",
          };
        }
        const comment = buildEscalationComment(state.feature, reason, findings) + syncNote;
        const outcome = await postEscalation(
          { workdir: state.workdir, branch: state.branch, comment, forge: forgeKind, preferTelegram },
          forge,
        );
        return outcome.url ? { url: outcome.url } : {};
      } catch (err) {
        return { deliveryError: errorMessage(err) };
      }
    },
  };

  if (deps.narrative !== false) {
    ops.narrate = async (state: FinishState) => {
      try {
        if (forgeKind === null) return;
        const input: FinishNarrativeInput = {
          base: state.base,
          model: models?.narrative,
          timeoutMs: timeouts?.narrativeMs,
        };
        const outcome = await _finishOpsDeps.callOp(
          { ...callCtx, sessionOverride: { role: "finish-narrative" } },
          finishNarrativeOp,
          input,
        );
        const ctx = await loadFinishPrContext({
          state,
          audit,
          forge: forgeKind,
          prBody,
          narrative: outcome.narrative,
          title: outcome.title,
        });
        await updatePrBody(
          {
            workdir: state.workdir,
            branch: state.branch,
            title: buildFinishTitle(ctx),
            body: buildFinishBody(ctx),
            forge: forgeKind,
          },
          forge,
        );
      } catch (err) {
        warn?.("nax-finish could not write the PR narrative", { error: err });
      }
    };
  }

  return ops;
}
