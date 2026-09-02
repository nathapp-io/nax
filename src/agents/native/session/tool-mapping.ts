/**
 * ToolDescriptor -> ToolDefinition.
 *
 * Nearly one-to-one. The budget fields stay behind deliberately: nax executes
 * these tools, so `maxCallsPerSession` and `maxTokensPerCall` are enforced by
 * PullToolBudget on this side and mean nothing to a provider.
 */

import type { ToolDefinition } from "@nathapp/nax-ai";
import type { ToolDescriptor } from "@/context/engine";

export function toToolDefinitions(descriptors: readonly ToolDescriptor[]): ToolDefinition[] {
  return descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
}
