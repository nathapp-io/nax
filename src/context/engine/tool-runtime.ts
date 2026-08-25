/**
 * Context Engine — Pull Tool Runtime
 *
 * Bridges ContextBundle.pullTools to concrete server-side handlers used by
 * agent adapters. The current ACP adapter consumes this through a small
 * text-based tool-call protocol in its multi-turn loop.
 */

import type { ContextToolRuntimeConfig } from "@/config/selectors";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { UserStory } from "@/prd";
import type { ResolvedTestPatterns } from "@/test-runners";
import { resolveTestFilePatterns } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
// STYLE-6 fix: import handleQueryScratch directly from its handler module
// to avoid the circular `pull-tools.ts` ↔ `handlers/query-scratch.ts`
// reference that the previous re-export created.
import { handleQueryScratch } from "./handlers/query-scratch";
import type { RunCallCounter } from "./pull-tools";
import { createRunCallCounter, handleQueryFeatureContext, handleQueryNeighbor, PullToolBudget } from "./pull-tools";
import type { ContextBundle, ToolDescriptor } from "./types";

export interface ContextToolRuntime {
  callTool(name: string, input: unknown): Promise<string>;
}

/**
 * Per-tool budgets for one agent session, keyed by tool name.
 *
 * Must be created once per session and shared across every runtime built for
 * it. `createContextToolRuntime` is called inside the hop closure
 * (build-hop-callback), so a runtime-local map would reset
 * `maxCallsPerSession` on every retry / fallback / escalation hop — making the
 * per-session ceiling effectively unbounded and leaving only the run-level cap
 * real. Threaded exactly like `runCounter`, for the same reason.
 */
export type SessionToolBudgets = Map<string, PullToolBudget>;

/** Create an empty session-scoped budget registry. */
export function createSessionToolBudgets(): SessionToolBudgets {
  return new Map<string, PullToolBudget>();
}

function descriptorByName(bundle: ContextBundle): Map<string, ToolDescriptor> {
  return new Map(bundle.pullTools.map((tool) => [tool.name, tool]));
}

export function createContextToolRuntime(options: {
  bundle: ContextBundle;
  story: UserStory;
  config: ContextToolRuntimeConfig;
  /** Absolute path to the repository root (AC-54). Used by all pull tool handlers. */
  repoRoot: string;
  runCounter?: RunCallCounter;
  /**
   * Session-scoped budget registry. Pass the same instance for every runtime
   * built within one agent session so per-session ceilings survive hops.
   * Omitted (tests, one-shot callers) means this runtime gets its own allowance.
   */
  sessionBudgets?: SessionToolBudgets;
  /**
   * Story scratch directories (US-005). Threaded through from the
   * stage-assembly path so the query_scratch pull-tool handler reads the
   * same session data as the push-style SessionScratchProvider /
   * ToolDiagnosticsProvider. Absent / empty disables the scratch handler
   * (it returns a no-entries message on its own — never throws).
   */
  storyScratchDirs?: string[];
  /**
   * Agent id of the requester (the agent invoking the pull tools). Threaded
   * from buildHopCallback's hop agent so query_scratch neutralizes
   * agent-specific tool references for the actual reader (AC-42 / US-005 AC10)
   * instead of the handler's story.id default.
   */
  agentId?: string;
}): ContextToolRuntime | undefined {
  const { bundle, story, config, repoRoot } = options;
  if (bundle.pullTools.length === 0) return undefined;

  const descriptors = descriptorByName(bundle);
  const budgets = options.sessionBudgets ?? createSessionToolBudgets();
  const runCounter = options.runCounter ?? createRunCallCounter();
  const maxCallsPerRun = config.context?.v2?.pull?.maxCallsPerRun ?? 50;

  // ADR-009 SSOT: resolve test patterns once per runtime (one per story) so
  // pull-tool handlers can inject them into ContextRequest without re-resolving
  // on every agent call. Lazily computed on first use; failures are logged and
  // the handler degrades to skipping sibling-test hinting.
  let resolvedTestPatternsPromise: Promise<ResolvedTestPatterns | undefined> | null = null;
  async function getResolvedTestPatterns(): Promise<ResolvedTestPatterns | undefined> {
    if (resolvedTestPatternsPromise === null) {
      resolvedTestPatternsPromise = resolveTestFilePatterns(config, repoRoot, story.workdir || undefined, {
        storyId: story.id,
      }).catch((err) => {
        getLogger().warn("context", "Pull-tool runtime: failed to resolve test patterns", {
          storyId: story.id,
          error: errorMessage(err),
        });
        return undefined;
      });
    }
    return resolvedTestPatternsPromise;
  }

  function getBudget(tool: ToolDescriptor): PullToolBudget {
    const existing = budgets.get(tool.name);
    if (existing) return existing;
    const created = new PullToolBudget(tool.maxCallsPerSession, maxCallsPerRun, runCounter);
    budgets.set(tool.name, created);
    return created;
  }

  return {
    async callTool(name: string, input: unknown): Promise<string> {
      const tool = descriptors.get(name);
      if (!tool) {
        throw new NaxError(`Unknown context tool: ${name}`, "PULL_TOOL_UNKNOWN", {
          stage: "pull-tool",
          storyId: story.id,
          tool: name,
          availableTools: [...descriptors.keys()].sort(),
        });
      }

      switch (name) {
        case "query_neighbor": {
          const patterns = await getResolvedTestPatterns();
          return handleQueryNeighbor(
            input as { filePath: string; depth?: number },
            repoRoot,
            getBudget(tool),
            tool.maxTokensPerCall,
            patterns,
            story.id,
            config.context?.v2?.providers,
          );
        }
        case "query_feature_context":
          return handleQueryFeatureContext(
            input as { filter?: string },
            story,
            config,
            repoRoot,
            getBudget(tool),
            tool.maxTokensPerCall,
            // Without the bundle's feature the provider cannot reach this
            // story's dependency fragments (it early-returns on a missing id).
            bundle.featureId,
          );
        case "query_scratch":
          return handleQueryScratch(
            input as { kind?: string; limit?: number },
            story,
            options.storyScratchDirs ?? [],
            getBudget(tool),
            tool.maxTokensPerCall,
            options.agentId ? { targetAgent: options.agentId } : {},
          );
        default:
          throw new NaxError(`No runtime handler for context tool: ${name}`, "PULL_TOOL_NO_HANDLER", {
            stage: "pull-tool",
            storyId: story.id,
            tool: name,
          });
      }
    },
  };
}
