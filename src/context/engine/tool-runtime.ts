/**
 * Context Engine — Pull Tool Runtime
 *
 * Bridges ContextBundle.pullTools to concrete server-side handlers used by
 * agent adapters. The current ACP adapter consumes this through a small
 * text-based tool-call protocol in its multi-turn loop.
 */

import type { ContextToolRuntimeConfig } from "../../config/selectors";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { resolveTestFilePatterns } from "../../test-runners/resolver";
import type { ResolvedTestPatterns } from "../../test-runners/resolver";
import { errorMessage } from "../../utils/errors";
import { PullToolBudget, createRunCallCounter, handleQueryFeatureContext, handleQueryNeighbor } from "./pull-tools";
import type { RunCallCounter } from "./pull-tools";
import type { ContextBundle, ToolDescriptor } from "./types";

export interface ContextToolRuntime {
  callTool(name: string, input: unknown): Promise<string>;
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
}): ContextToolRuntime | undefined {
  const { bundle, story, config, repoRoot } = options;
  if (bundle.pullTools.length === 0) return undefined;

  const descriptors = descriptorByName(bundle);
  const budgets = new Map<string, PullToolBudget>();
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
        throw new Error(`Unknown context tool: ${name}`);
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
          );
        default:
          throw new Error(`No runtime handler for context tool: ${name}`);
      }
    },
  };
}
