import { buildContextToolPreamble, buildRunInteractionHandler } from "@/agents/acp/adapter";
import { NO_OP_INTERACTION_HANDLER } from "@/agents/interaction-handler";
import type { IAgentManager } from "@/agents/manager-types";
import type { AgentAdapter, AgentResult, CompleteOptions, ResolvedCompleteOptions } from "@/agents/types";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import { resolvePermissions } from "@/config/permissions";
import { getLogger } from "@/logger";
import type { IDispatchEventBus } from "@/runtime/dispatch-events";
import { formatSessionName } from "@/runtime/session-name";

export interface FakeAgentManagerOptions {
  /** Optional default agent name override. Defaults to adapter.name. */
  defaultAgentName?: string;
  /**
   * Optional dispatch-event bus. When provided, runWithFallback and runAsSession
   * emit a minimal `session-turn` event after each turn — mirroring what the
   * production AgentManager middleware does. Tests that exercise dispatch-event
   * subscribers (e.g. tokenUsage capture via CallContext.scopeId) must wire this.
   */
  dispatchEvents?: IDispatchEventBus;
}

/**
 * Test-only fake manager. Wraps an adapter with no middleware chain and
 * no fallback policy. Use ONLY in unit tests that don't need a full
 * runtime. Production code must use createRuntime(...).agentManager.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D3
 */
export function fakeAgentManager(
  adapter: AgentAdapter,
  defaultAgentNameOrOpts?: string | FakeAgentManagerOptions,
): IAgentManager {
  const opts: FakeAgentManagerOptions =
    typeof defaultAgentNameOrOpts === "string"
      ? { defaultAgentName: defaultAgentNameOrOpts }
      : (defaultAgentNameOrOpts ?? {});
  const defaultAgentName = opts.defaultAgentName;
  const dispatchEvents = opts.dispatchEvents;
  const resolvePermissionsFor: typeof resolvePermissions = (config, stage) =>
    resolvePermissions((config as NaxConfig | undefined) ?? DEFAULT_CONFIG, stage);
  // Mirrors AgentManager.completeAs: fills in resolvedPermissions before handing
  // options to the adapter, producing the ResolvedCompleteOptions the adapter boundary
  // requires (src/agents/types.ts:314, manager.ts:493-501).
  const resolveCompleteOpts = (o: CompleteOptions): ResolvedCompleteOptions => ({
    ...o,
    resolvedPermissions: o.resolvedPermissions ?? resolvePermissionsFor(o.config, o.pipelineStage ?? "run"),
  });
  const warnMismatch = (method: string, requested: string): void => {
    if (requested !== adapter.name) {
      getLogger().warn("agents", "fakeAgentManager: agentName mismatch — test manager wraps a single adapter", {
        method,
        requested,
        wrapped: adapter.name,
      });
    }
  };
  const mgr: IAgentManager = {
    getDefault: () => defaultAgentName ?? adapter.name,
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async (req) => {
      const opts = req.runOptions;
      const startTime = Date.now();
      const resolvedPermissions =
        opts.resolvedPermissions ?? resolvePermissionsFor(opts.config, opts.pipelineStage ?? "run");
      const sessionName =
        opts.sessionHandle ??
        formatSessionName({
          workdir: opts.workdir ?? ".",
          featureName: opts.featureName,
          storyId: opts.storyId,
          role: opts.sessionRole,
          pipelineStage: opts.pipelineStage,
        });
      let result: AgentResult;
      try {
        const handle = await adapter.openSession(sessionName, {
          agentName: adapter.name,
          workdir: opts.workdir,
          resolvedPermissions,
          modelDef: opts.modelDef,
          timeoutSeconds: opts.timeoutSeconds,
          onSessionEstablished: opts.onSessionEstablished,
          signal: opts.abortSignal,
        });
        try {
          const hasContextTools = Boolean(opts.contextToolRuntime && (opts.contextPullTools?.length ?? 0) > 0);
          const maxTurns =
            opts.interactionBridge || hasContextTools
              ? (opts.maxInteractionTurns ?? 10)
              : (opts.maxInteractionTurns ?? 1);
          const turnResult = await adapter.sendTurn(handle, buildContextToolPreamble(opts), {
            interactionHandler: buildRunInteractionHandler(opts),
            signal: opts.abortSignal,
            maxTurns,
          });
          result = {
            success: true,
            exitCode: 0,
            output: turnResult.output,
            rateLimited: false,
            durationMs: Date.now() - startTime,
            estimatedCostUsd: turnResult.estimatedCostUsd ?? 0,
            exactCostUsd: turnResult.exactCostUsd,
            tokenUsage: turnResult.tokenUsage,
          };
          // Emit a minimal session-turn dispatch event so subscribers wired via
          // CallContext.scopeId can observe turn outcomes. Mirrors what AgentManager
          // middleware emits in production. No-op when no bus was supplied.
          if (dispatchEvents) {
            dispatchEvents.emitDispatch({
              kind: "session-turn",
              sessionName,
              sessionRole: opts.sessionRole ?? "main",
              prompt: opts.prompt ?? "",
              response: turnResult.output ?? "",
              agentName: adapter.name,
              stage: opts.pipelineStage ?? "run",
              storyId: opts.storyId,
              featureName: opts.featureName,
              workdir: opts.workdir,
              resolvedPermissions,
              tokenUsage: turnResult.tokenUsage,
              estimatedCostUsd: turnResult.estimatedCostUsd,
              exactCostUsd: turnResult.exactCostUsd,
              durationMs: Date.now() - startTime,
              timestamp: Date.now(),
              turn: 1,
              protocolIds: {},
              origin: "runAsSession",
              ...(opts.scopeId !== undefined ? { scopeId: opts.scopeId } : {}),
            });
          }
        } finally {
          await adapter.closeSession(handle).catch(() => {});
        }
      } catch (err) {
        result = {
          success: false,
          exitCode: 1,
          output: err instanceof Error ? err.message : String(err),
          rateLimited: false,
          durationMs: Date.now() - startTime,
          estimatedCostUsd: 0,
          adapterFailure: {
            category: "quality",
            outcome: "fail-unknown",
            retriable: false,
            message: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          },
        };
      }
      return { result, fallbacks: [] };
    },
    completeWithFallback: async (prompt, opts) => ({
      result: await adapter.complete(prompt, opts),
      fallbacks: [],
    }),
    run: async (req) => {
      const outcome = await mgr.runWithFallback(req);
      return { ...outcome.result, agentFallbacks: outcome.fallbacks };
    },
    complete: async (prompt, opts) => adapter.complete(prompt, resolveCompleteOpts(opts)),
    getAgent: () => adapter,
    events: { on: () => {} },
    runAs: async (agentName, req) => {
      warnMismatch("runAs", agentName);
      const outcome = await mgr.runWithFallback(req);
      return { ...outcome.result, agentFallbacks: outcome.fallbacks };
    },
    completeAs: async (agentName, prompt, opts) => {
      warnMismatch("completeAs", agentName);
      return adapter.complete(prompt, resolveCompleteOpts(opts));
    },
    // nax#1712: this fake drives a single adapter and never swaps, so it reports no hops.
    completeAsWithFallback: async (agentName, prompt, opts) => ({
      result: await mgr.completeAs(agentName, prompt, opts),
      fallbacks: [],
    }),
    runAsSession: async (_agentName, handle, prompt, _opts) => {
      return adapter.sendTurn(handle, prompt, { interactionHandler: NO_OP_INTERACTION_HANDLER });
    },
    close: () => {},
  };
  return mgr;
}
