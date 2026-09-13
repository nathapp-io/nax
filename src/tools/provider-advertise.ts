/**
 * Per-hop resolution of provider tools.
 *
 * A provider whose `tools()` rejects is DROPPED, not fatal: a broken provider
 * must never wedge a run. The failure is logged by the caller, which owns the
 * logger; this module stays pure so it can be tested without one.
 */
import type { PipelineStage } from "@/config/permissions";
import { adaptProviderTool } from "./provider-adapt";
import { expandProviderGrants } from "./provider-grants";
import { sanitizeProviderTools } from "./provider-sanitize";
import { providerAttachesTo, type ToolProvider } from "./provider-types";
import type { CodingTool } from "./registry";
import type { ToolGrant } from "./types";

export interface ResolvedProviderTools {
  readonly tools: readonly CodingTool[];
  readonly grants: readonly ToolGrant[];
  readonly failures: readonly { providerId: string; reason: string }[];
}

export async function resolveProviderTools(
  providers: readonly ToolProvider[],
  stage: PipelineStage,
  workdir: string,
): Promise<ResolvedProviderTools> {
  const tools: CodingTool[] = [];
  const entries: { providerId: string; localNames: string[] }[] = [];
  const failures: { providerId: string; reason: string }[] = [];

  for (const provider of providers) {
    if (!providerAttachesTo(provider, stage)) continue;
    try {
      const sanitized = sanitizeProviderTools(provider.kind, await provider.tools(workdir));
      const localNames: string[] = [];
      for (const tool of sanitized) {
        tools.push(adaptProviderTool(provider.id, tool));
        localNames.push(tool.localName);
      }
      entries.push({ providerId: provider.id, localNames });
    } catch (error) {
      failures.push({ providerId: provider.id, reason: String(error) });
    }
  }

  return { tools, grants: expandProviderGrants(entries), failures };
}
