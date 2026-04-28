import { DEFAULT_CONFIG } from "../../src/config";
import type { NaxConfig } from "../../src/config";
import { resolvePermissions } from "../../src/config/permissions";
import { getLogger } from "../../src/logger";
import { formatSessionName } from "../../src/runtime/session-name";
import { buildContextToolPreamble, buildRunInteractionHandler } from "../../src/agents/acp/adapter";
import { NO_OP_INTERACTION_HANDLER } from "../../src/agents/interaction-handler";
import type { IAgentManager } from "../../src/agents/manager-types";
import type { AgentAdapter, AgentResult } from "../../src/agents/types";

/**
 * Test-only fake manager. Wraps an adapter with no middleware chain and
 * no fallback policy. Use ONLY in unit tests that don't need a full
 * runtime. Production code must use createRuntime(...).agentManager.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D3
 */
export function fakeAgentManager(adapter: AgentAdapter, defaultAgentName?: string): IAgentManager {
  const warnMismatch = (method: string, requested: string): void => {
    if (requested !== adapter.name) {
      getLogger().warn(
        "agents",
        "fakeAgentManager: agentName mismatch — test manager wraps a single adapter",
        {
          method,
          requested,
          wrapped: adapter.name,
        },
      );
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
        opts.resolvedPermissions ??
        resolvePermissions((opts.config as NaxConfig | undefined) ?? DEFAULT_CONFIG, opts.pipelineStage ?? "run");
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
          onPidSpawned: opts.onPidSpawned,
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
    complete: async (prompt, opts) => adapter.complete(prompt, opts),
    getAgent: () => adapter,
    events: { on: () => {} },
    runAs: async (agentName, req) => {
      warnMismatch("runAs", agentName);
      const outcome = await mgr.runWithFallback(req);
      return { ...outcome.result, agentFallbacks: outcome.fallbacks };
    },
    completeAs: async (agentName, prompt, opts) => {
      warnMismatch("completeAs", agentName);
      return adapter.complete(prompt, opts);
    },
    runAsSession: async (_agentName, handle, prompt, _opts) => {
      return adapter.sendTurn(handle, prompt, { interactionHandler: NO_OP_INTERACTION_HANDLER });
    },
  };
  return mgr;
}
