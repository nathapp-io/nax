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
  /**
   * Advertised tool name -> owning provider id, carried explicitly so the
   * ledger never has to parse the `<id>__<local>` name apart (a naming
   * convention change would otherwise break telemetry silently).
   */
  readonly providerIdByTool: ReadonlyMap<string, string>;
}

export async function resolveProviderTools(
  providers: readonly ToolProvider[],
  stage: PipelineStage,
  workdir: string,
): Promise<ResolvedProviderTools> {
  const tools: CodingTool[] = [];
  const entries: { providerId: string; localNames: string[] }[] = [];
  const failures: { providerId: string; reason: string }[] = [];
  const providerIdByTool = new Map<string, string>();

  for (const provider of providers) {
    if (!providerAttachesTo(provider, stage)) continue;
    try {
      const sanitized = sanitizeProviderTools(provider.kind, await provider.tools(workdir));
      const localNames: string[] = [];
      for (const tool of sanitized) {
        const adapted = adaptProviderTool(provider.id, tool);
        tools.push(adapted);
        providerIdByTool.set(adapted.name, provider.id);
        localNames.push(tool.localName);
      }
      entries.push({ providerId: provider.id, localNames });
    } catch (error) {
      failures.push({ providerId: provider.id, reason: String(error) });
    }
  }

  return { tools, grants: expandProviderGrants(entries), failures, providerIdByTool };
}

/**
 * Bytes a tool list costs the prompt, paid on EVERY hop whether or not any
 * tool is called. This is the per-hop tax that appears in no ledger today and
 * which nax#1991's context-burn report needs.
 */
export function advertisedSchemaBytes(tools: readonly CodingTool[]): number {
  let total = 0;
  for (const tool of tools) {
    total += Buffer.byteLength(tool.description, "utf8") + Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8");
  }
  return total;
}
