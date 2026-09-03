/**
 * ToolDescriptor -> ToolDefinition.
 *
 * Nearly one-to-one. The budget fields stay behind deliberately: nax executes
 * these tools, so `maxCallsPerSession` and `maxTokensPerCall` are enforced by
 * PullToolBudget on this side and mean nothing to a provider.
 */

import type { ToolDefinition } from "@nathapp/nax-ai";
import type { ToolDescriptor } from "@/context/engine";
import type { CodingTool } from "@/tools";

export function toToolDefinitions(descriptors: readonly ToolDescriptor[]): ToolDefinition[] {
  return descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
}

/**
 * CodingTool -> ToolDefinition.
 *
 * `scope` and `run` stay behind for the same reason the pull tools' budget
 * fields do: nax executes these, so they mean nothing to a provider.
 */
export function codingToolsToDefinitions(tools: readonly CodingTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
