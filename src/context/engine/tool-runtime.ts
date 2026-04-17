/**
 * Context Engine — Pull Tool Runtime
 *
 * Bridges ContextBundle.pullTools to concrete server-side handlers used by
 * agent adapters. The current ACP adapter consumes this through a small
 * text-based tool-call protocol in its multi-turn loop.
 */

import type { NaxConfig } from "../../config/types";
import type { UserStory } from "../../prd";
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
  config: NaxConfig;
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
        case "query_neighbor":
          return handleQueryNeighbor(
            input as { filePath: string; depth?: number },
            repoRoot,
            getBudget(tool),
            tool.maxTokensPerCall,
          );
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
