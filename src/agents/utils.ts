import { DEFAULT_CONFIG } from "../config";
import type { NaxConfig } from "../config";
import { resolvePermissions } from "../config/permissions";
import { getLogger } from "../logger";
import { formatSessionName } from "../session/naming";
import { buildContextToolPreamble, buildRunInteractionHandler } from "./acp/adapter";
import { NO_OP_INTERACTION_HANDLER } from "./interaction-handler";
import type { IAgentManager } from "./manager-types";
import type { AgentAdapter, AgentResult } from "./types";

const FALLBACK_DEFAULT_AGENT = "claude";

export function resolveDefaultAgent(config: NaxConfig): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return FALLBACK_DEFAULT_AGENT;
}

/**
 * Wrap a single AgentAdapter as a minimal IAgentManager with no fallback logic.
 * Used by session runners when no AgentManager is available (test / bootstrap
 * paths) so SessionManager.runInSession always receives an IAgentManager.
 * ADR-013 Phase 1.
 */
export function wrapAdapterAsManager(adapter: AgentAdapter): IAgentManager {
  const warnMismatch = (method: string, requested: string): void => {
    if (requested !== adapter.name) {
      getLogger().warn(
        "agents",
        "wrapAdapterAsManager: agentName mismatch — bootstrap manager wraps a single adapter",
        {
          method,
          requested,
          wrapped: adapter.name,
        },
      );
    }
  };
  const mgr: IAgentManager = {
    getDefault: () => adapter.name,
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
