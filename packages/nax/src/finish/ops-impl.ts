/**
 * The concrete `FinishOps` the state machine runs against.
 *
 * A factory rather than a module of free functions: every method needs the
 * same closed-over `CallContext`, forge deps and model selections, and the
 * machine's contract (`./ops`) is an object. `reviewSpec` / `reviewBranch` /
 * `fix` deliberately do not catch: a reviewer or fixer that cannot run is
 * exactly the case the machine's catch exists for. The forge-facing methods
 * (`promotePr`, `finalizeDraftPr`) propagate a CLI failure too -- the machine
 * reports it as a failed finish rather than a PR that was never written.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { formatDecisionsForPrompt, formatRulingsForFix, readTrustedDecisions } from "@/advisor";
import type { ConfiguredModel } from "@/config";
import type { ForgeDeps, ForgeKind } from "@/forge";
import type { CallContext, FinishBranchReviewInput, FinishFixInput, FinishSpecReviewInput } from "@/operations";
import { callOp, finishBranchReviewOp, finishFixOp, finishSpecReviewOp, HANDOFF_TURN_MS } from "@/operations";
import { STEP_TIMEOUT_MARGIN_MS, stepSignal } from "@/utils/step-signal";
import type { AuditTarget } from "./audit";
import { commitAndPush } from "./commit";
import { setAsideLeftoverDirt } from "./finalize-dirt";
import type { FinishOps, FixPhase, FixRequest, ReviewInputs } from "./ops";
import { buildFinishBody, buildFinishTitle, loadFinishPrContext, openDraftFinishPr, openOrPromotePr } from "./pr";
import { stopReason } from "./resolve";
import { MISSING_REVIEW } from "./review-json";
import type { FinishState } from "./state";
import type { FinishPrBodySettings, FinishReviewOutput, FinishTimeouts } from "./types";

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
  };
  timeouts?: Pick<FinishTimeouts, "reviewMs" | "fixMs">;
  /** The run's own signal: the fix op's hard stop. The soft interrupt arrives on the request. */
  runSignal?: AbortSignal;
  /** The existing `FinishPrBodySettings` from `./types` (D4.8). */
  prBody?: FinishPrBodySettings;
}

export const _finishOpsDeps: { callOp: typeof callOp } = { callOp };

/** A1: waived / superseded advisor decisions for the review prompt. Never throws: no ledger reads as none. */
async function loadDecisionNotes(state: FinishState, outputDir: string | undefined): Promise<string | undefined> {
  if (!outputDir) return undefined;
  const decisions = await readTrustedDecisions(state.workdir, state.feature, outputDir).catch(() => []);
  const notes = formatDecisionsForPrompt(decisions);
  return notes === "" ? undefined : notes;
}

/** Finish B 4.2: rulings in force for a fixer. Never throws: no ledger reads as none. */
async function loadFixRulings(
  state: FinishState,
  outputDir: string | undefined,
): Promise<{ text: string; ids: string[] }> {
  if (!outputDir) return { text: "", ids: [] };
  const decisions = await readTrustedDecisions(state.workdir, state.feature, outputDir).catch(() => []);
  return formatRulingsForFix(decisions);
}

/** The commit the promote path pushes before touching the forge (matches the flow, line 344). */
const PROMOTE_MESSAGE = (feature: string): string => `fix(${feature}): nax-finish automated fixes`;

/** The minimal body used when rendering throws: keeps the draft reason and the open findings visible. */
function fallbackBody(state: FinishState, error: string): string {
  const lines = ["## Unresolved", ""];
  const resolution = state.resolution;
  if (resolution?.reason) lines.push(`Reason: ${resolution.reason}`);
  const stopped = stopReason(state.stops ?? []);
  if (stopped) lines.push(`Stopped: ${stopped}`);
  for (const h of state.handoffs ?? []) lines.push(`- Set aside: ${h.dir}`);
  for (const f of resolution?.facts.findingsOpen ?? []) lines.push(`- [${f.severity}] ${f.title}`);
  lines.push("", `PR body could not be generated: ${error}`);
  return lines.join("\n");
}

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
  outputDir: string | undefined,
): Promise<{ title: string; body: string }> {
  try {
    const ctx = await loadFinishPrContext({ state, audit, forge: forgeKind, prBody, outputDir });
    return { title: buildFinishTitle(ctx), body: buildFinishBody(ctx) };
  } catch (err) {
    return { title: `feat: ${state.feature}`, body: fallbackBody(state, errorMessage(err)) };
  }
}

/** Add a commit nobody reviewed to the state and to the frozen resolution the PR body renders. */
function recordUnreviewedCommit(state: FinishState, sha: string): void {
  state.unreviewedFixCommits = [...state.unreviewedFixCommits, sha];
  if (!state.resolution) return;
  const { facts } = state.resolution;
  state.resolution = {
    ...state.resolution,
    facts: { ...facts, unreviewedFixCommits: [...facts.unreviewedFixCommits, sha] },
  };
}

const STOPPED_REVIEW: FinishReviewOutput = { ...MISSING_REVIEW, stoppedAtLimit: true };

/** One review call under its `reviewMs` limit: cut off or late, it reads as a missing verdict. */
async function underReviewLimit(
  callCtx: CallContext,
  reviewMs: number | undefined,
  run: (ctx: CallContext) => Promise<FinishReviewOutput>,
): Promise<FinishReviewOutput> {
  const { signal, limit } = stepSignal(callCtx.signal, reviewMs);
  const stoppedHere = (): boolean => limit?.aborted === true && callCtx.signal?.aborted !== true;
  try {
    const out = await run(signal ? { ...callCtx, signal } : callCtx);
    return stoppedHere() ? STOPPED_REVIEW : out;
  } catch (err) {
    if (stoppedHere()) return STOPPED_REVIEW;
    throw err;
  }
}

const reviewTimeout = (reviewMs: number | undefined): number | undefined =>
  reviewMs !== undefined ? reviewMs + STEP_TIMEOUT_MARGIN_MS : undefined;

export function createFinishOps(deps: FinishOpsDeps): FinishOps {
  const { callCtx, forge, forgeKind, audit, models, timeouts, prBody } = deps;
  // A1: where advisor audit artifacts live. Undefined (a bare test context) ⇒ no decision is trusted or shown.
  const advisorOutputDir: string | undefined = callCtx.runtime?.outputDir;

  const ops: FinishOps = {
    async reviewSpec(state: FinishState, inputs: ReviewInputs) {
      const input: FinishSpecReviewInput = {
        base: state.base,
        specPath: state.specPath,
        prdPath: inputs.prdPath,
        changedFiles: inputs.changed,
        decisions: await loadDecisionNotes(state, advisorOutputDir),
        model: models?.reviewSpec,
        timeoutMs: reviewTimeout(timeouts?.reviewMs),
      };
      return underReviewLimit(callCtx, timeouts?.reviewMs, (ctx) =>
        _finishOpsDeps.callOp({ ...ctx, sessionOverride: { role: "finish-review-spec" } }, finishSpecReviewOp, input),
      );
    },

    async reviewBranch(state: FinishState, inputs: ReviewInputs) {
      const input: FinishBranchReviewInput = {
        base: state.base,
        stories: inputs.stories,
        changedFiles: inputs.changed,
        hints: inputs.hints,
        decisions: await loadDecisionNotes(state, advisorOutputDir),
        model: models?.reviewQuality,
        timeoutMs: reviewTimeout(timeouts?.reviewMs),
      };
      return underReviewLimit(callCtx, timeouts?.reviewMs, (ctx) =>
        _finishOpsDeps.callOp(
          { ...ctx, sessionOverride: { role: "finish-review-quality" } },
          finishBranchReviewOp,
          input,
        ),
      );
    },

    async fix(phase: FixPhase, req: FixRequest) {
      const { state, findings, failing, gateOutput, acceptanceOutput, interrupt, continuation } = req;
      const rulings = await loadFixRulings(state, advisorOutputDir);
      const input: FinishFixInput = {
        phase,
        workdir: state.workdir,
        findings,
        failing,
        gateOutput,
        acceptanceOutput,
        model: models?.fix,
        // The agent's own timeout trails the step limit by the handoff turn and a margin, so fixMs fires first.
        timeoutMs:
          timeouts?.fixMs !== undefined ? timeouts.fixMs + HANDOFF_TURN_MS + STEP_TIMEOUT_MARGIN_MS : undefined,
        ...(interrupt ? { interrupt } : {}),
        ...(continuation ? { continuation } : {}),
        ...(rulings.text ? { rulings: rulings.text, rulingIds: rulings.ids } : {}),
        ...(req.acceptancePaths ? { acceptancePaths: req.acceptancePaths } : {}),
      };
      // Not `callCtx` alone — an explicit `sessionOverride: undefined` makes sure a
      // context the caller built with one set (e.g. for a review call reused here)
      // doesn't leak a reviewer role into the fixer once a caller starts wiring one in.
      // `signal: undefined` falls back to the runtime signal: the hard stop is the run's, never the step's.
      return _finishOpsDeps.callOp(
        { ...callCtx, sessionOverride: undefined, signal: deps.runSignal },
        finishFixOp,
        input,
      );
    },

    async openDraftPr(state: FinishState) {
      if (forgeKind === null) return null;
      // A context-load or render failure here must not surface as a throw: the
      // draft is a convenience (D4.5) and the safe response to any failure in
      // producing its content is the same as to any failure opening it — skip.
      let content: { title: string; body: string };
      try {
        const ctx = await loadFinishPrContext({
          state,
          audit,
          forge: forgeKind,
          prBody,
          outputDir: advisorOutputDir,
        });
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
      // Fourth commit site (#1674 part 3 review fix): `machine.ts`'s three
      // fix-loop sites (acceptance/review/gate) are not the only place a
      // commit can land this run. The terminal gate pass can leave the tree
      // dirty on its own — an auto-fixing lint/build step, a pre-commit hook
      // re-staging files — even when every fix loop above finished clean, so
      // `commitAndPush` here can commit real content that none of those three
      // sites ever saw. `state.committedThisRun` must reflect that BEFORE
      // `openOrPromotePr` (called below) reads
      // it, or a run that pushed a real commit still gets skipped for the
      // body write it earned.
      const { committed } = await commitAndPush(state.workdir, state.branch, PROMOTE_MESSAGE(state.feature), {
        excludeDir: audit.auditDir,
      });
      if (committed) state.committedThisRun = true;
      if (forgeKind === null) return { status: "local-only" };
      const content = await buildPrContentOrFallback(state, audit, forgeKind, prBody, advisorOutputDir);
      return openOrPromotePr(
        {
          workdir: state.workdir,
          branch: state.branch,
          title: content.title,
          body: content.body,
          forge: forgeKind,
          committedThisRun: state.committedThisRun,
        },
        forge,
      );
    },

    async finalizeDraftPr(state: FinishState) {
      // Hooks off: a draft must always land (a deadline can leave a killed fix
      // session's half-edited tree here, which a pre-commit hook would reject).
      // That commit never passed a review, so it is listed as unreviewed.
      const skipCommit = await setAsideLeftoverDirt(state, audit);
      const { committed, sha } = await commitAndPush(state.workdir, state.branch, PROMOTE_MESSAGE(state.feature), {
        skipHooks: true,
        skipCommit,
        excludeDir: audit.auditDir,
      });
      if (committed) {
        state.committedThisRun = true;
        if (sha) recordUnreviewedCommit(state, sha);
      }
      if (forgeKind === null) return { status: "local-only" };
      const content = await buildPrContentOrFallback(state, audit, forgeKind, prBody, advisorOutputDir);
      const out = await openOrPromotePr(
        {
          workdir: state.workdir,
          branch: state.branch,
          title: content.title,
          body: content.body,
          forge: forgeKind,
          committedThisRun: true,
          keepDraft: true,
        },
        forge,
      );
      // A PR a human already marked ready is not demoted; report that honestly.
      return { status: out.status === "already-ready" ? "already-ready" : "draft", url: out.url };
    },
  };

  return ops;
}
