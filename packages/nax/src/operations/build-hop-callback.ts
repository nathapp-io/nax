/**
 * buildHopCallback — per-hop bundle-rebuild + session-dispatch factory (Phase C).
 *
 * Returned closure matches AgentRunRequest["executeHop"] and is passed
 * directly to runWithFallback.
 *
 * The closure body lives in two siblings: build-hop-callback-hop.ts (composeHopPrompt
 * → resolveHopTooling → prepareHopSession → acquireSessionHandle → recordSwapHandoff)
 * and build-hop-callback-dispatch.ts (dispatchHopTurn: the turn try/catch/finally).
 * What stays here is the callback-scoped state: `_buildHopCallbackDeps` (the
 * test-injection seam tests reassign by PROPERTY, so it must remain the object the
 * phases read through), the session-scoped pull budgets and run counter, and
 * `HopClosureState` — the US-003/AC5 cross-hop bookkeeping mutated in place by the
 * phases.
 */

import type { AgentRunRequest, IAgentManager } from "../agents/manager-types";
import type { AgentRunOptions, TurnResult } from "../agents/types";
import type { NaxConfig, resolveModelForAgent } from "../config";
import type { ContextBundle, RunCallCounter } from "../context/engine";
import {
  ContextOrchestrator,
  createContextToolRuntime,
  createRunCallCounter,
  createSessionToolBudgets,
} from "../context/engine";
import { writeRebuildManifest } from "../context/engine/manifest-store";
import type { UserStory } from "../prd";
import type { TimeoutRetryInput } from "../prompts";
import { timeoutRetry as defaultTimeoutRetry } from "../prompts";
import type { ISessionManager } from "../session";
import { captureGitRef, captureWorkingTreeChanges } from "../utils/git";
import { dispatchHopTurn } from "./build-hop-callback-dispatch";
import {
  acquireSessionHandle,
  composeHopPrompt,
  type HopClosureState,
  type HopInvocation,
  type HopOutcome,
  prepareHopSession,
  recordSwapHandoff,
  resolveHopTooling,
} from "./build-hop-callback-hop";
import { hopModelId, hopTier } from "./hop-endpoint";

// Re-exported from their new home so existing importers (and
// test/unit/operations/build-hop-callback-tier.test.ts) are unaffected.
export { hopModelId, hopTier };

export const _buildHopCallbackDeps = {
  rebuildForAgent: (
    prior: ContextBundle,
    newAgentId: string,
    failure: import("../context/engine").AdapterFailure,
    storyId?: string,
  ): ContextBundle => new ContextOrchestrator([]).rebuildForAgent(prior, { newAgentId, failure, storyId }),
  writeRebuildManifest,
  createContextToolRuntime,
  captureGitRef,
  captureWorkingTreeChanges,
  timeoutRetry: (input: TimeoutRetryInput): string => defaultTimeoutRetry(input),
};

export interface BuildHopCallbackContext {
  sessionManager: ISessionManager;
  agentManager: IAgentManager;
  story: UserStory;
  config: NaxConfig;
  projectDir?: string;
  featureName: string;
  workdir: string;
  effectiveTier: Parameters<typeof resolveModelForAgent>[2];
  defaultAgent: string;
  /**
   * The agent `runOptions.modelDef` was resolved for — `dispatchAgent` in callOp, which
   * may differ from `ctx.agentName` when `op.model` pins an `{ agent, model }` pair.
   *
   * nax#1722: a hop can now run on a DIFFERENT agent than the options were resolved for
   * (`resolveStartAgent` starts an operation on a fallback when the primary is already
   * unavailable). A pinned modelDef belongs to this agent alone; carried onto another it
   * sends codex the model `haiku`, which the ACP agent rejects outright
   * ("did not advertise that model"). Absent = trust the pin, the pre-#1722 behaviour.
   */
  pinnedModelAgent?: string;
  contextToolRunCounter?: RunCallCounter;
  pipelineStage?: import("../config/permissions").PipelineStage;
  /**
   * Story scratch directories (US-005). Threaded from the stage-assembly
   * path (PipelineContext.storyScratchDirs) so the pull-tool runtime's
   * query_scratch handler reads the same set of session data as the push
   * providers (SessionScratchProvider / ToolDiagnosticsProvider). Absent /
   * empty disables the scratch handler (it returns a no-entries message on
   * its own — never throws).
   */
  storyScratchDirs?: string[];
  /**
   * Optional interaction bridge for mid-session human Q&A. Forwarded to
   * `buildRunInteractionHandler` so the agent can ask questions during a hop.
   */
  interactionBridge?: {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  };
  /** Max interaction round-trips when interactionBridge is active (default: 10). */
  maxInteractionTurns?: number;
  /**
   * Optional intra-hop multi-prompt body. When set, the callback invokes
   * `hopBody(initialPrompt, { send })` instead of issuing a single
   * `runAsSession` call. The `send` closure dispatches one turn against the
   * current handle. Used by review ops for same-session JSON-parse retry.
   */
  hopBody?: <I = unknown>(
    initialPrompt: string,
    bodyCtx: { send: (prompt: string) => Promise<TurnResult>; input: I },
  ) => Promise<TurnResult>;
  /** Input value forwarded to `hopBody` via its `ctx.input`. */
  hopBodyInput?: unknown;
}

export function buildHopCallback(
  ctx: BuildHopCallbackContext,
  sessionId: string | undefined,
  _initialOptions: AgentRunOptions,
): NonNullable<AgentRunRequest["executeHop"]> {
  const { contextToolRunCounter, pipelineStage } = ctx;

  const stage = pipelineStage ?? "run";

  // US-003 / AC5: cross-hop state, mutated IN PLACE by the phase functions in
  // build-hop-callback-hop.ts. See HopClosureState there for what each field pins.
  const state: HopClosureState = {};

  // Gap finding 7: pull-tool budgets must be scoped to the SESSION, not the hop.
  // The context-tool runtime is created once per hop, so a runtime-local registry
  // reset maxCallsPerSession on every retry / fallback / escalation. Created here,
  // outside the closure, alongside contextToolRunCounter — which until now was
  // declared but never populated by any production caller, so the run-level cap
  // reset per hop too (call.ts).
  const sessionToolBudgets = createSessionToolBudgets();
  // The counter is now threaded from the context stage through CallContext and
  // hopCtx (call.ts), so a real one arrives here. The fallback covers callers
  // that construct a hop context directly — tests, and any op invoked outside
  // the pipeline. Hoisted out of the closure either way so it survives hops.
  const runCounterForHops = contextToolRunCounter ?? createRunCallCounter();

  return async (agentName, hopBundle, hopKind, resolvedRunOptions): Promise<HopOutcome> => {
    // deps is _buildHopCallbackDeps BY REFERENCE: tests reassign its properties
    // between buildHopCallback() and invoking the closure, so every phase must
    // read deps.X at call time (never destructure outside a hop).
    const input: HopInvocation = {
      ctx,
      deps: _buildHopCallbackDeps,
      stage,
      sessionId,
      sessionToolBudgets,
      runCounterForHops,
      state,
      agentName,
      hopBundle,
      hopKind,
      resolvedRunOptions,
    };

    // Swap rebuild / timeout-retry prompt composition + the once-only pre-attempt
    // git-ref capture (US-003). Mutates input.state in place.
    const composed = await composeHopPrompt(input);

    // Pull-tool runtime, tool preamble, coding-tool support (its #1794 refusal is
    // converted into the failed AgentResult below, not propagated), diff-access
    // substitution, interaction handler.
    const tooling = await resolveHopTooling(input, composed);
    if (!tooling.ok) {
      // US-001: coding-tool setup failed before any adapter was reached — no
      // model was dispatched. Same signal as the dispatch catch path.
      return {
        result: tooling.result,
        bundle: composed.workingBundle,
        prompt: tooling.prompt,
        dispatched: false,
      };
    }

    // Session identity + the opener; openFresh returns the endpoint it resolved.
    const session = prepareHopSession(input);
    // endpoint is undefined exactly when a stale-retry reused a warm handle.
    const acquired = await acquireSessionHandle(input, session);
    // nax#1722: record the descriptor handoff for any swap, sessionId or not.
    recordSwapHandoff(input, session.sessionName);

    return dispatchHopTurn({
      input,
      tooling: tooling.tooling,
      handle: acquired.handle,
      endpoint: acquired.endpoint,
    });
  };
}
