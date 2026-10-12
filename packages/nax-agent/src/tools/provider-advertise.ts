/**
 * Per-hop resolution of provider tools.
 *
 * A provider whose `tools()` rejects is DROPPED, not fatal: a broken provider
 * must never wedge a run. The failure reason is carried in `failures` and
 * logged by the caller, which owns the logger. Stage mismatches and
 * `admits`-rejected tools are carried in `skipped`/`withheld` (#2410) and the
 * stage skip is logged once here at debug — the null-safe logger keeps the
 * module testable without one.
 */
import { getSafeLogger } from "#src/infra/index";
import { adaptProviderTool } from "./provider-adapt.ts";
import { expandProviderGrants, type ProviderGrantEntry } from "./provider-grants.ts";
import { sanitizeProviderTools } from "./provider-sanitize.ts";
import { providerAttachesTo, type ToolProvider } from "./provider-types.ts";
import type { CodingTool } from "./registry.ts";
import type { ToolGrant } from "./types.ts";

export interface ResolvedProviderTools {
  readonly tools: readonly CodingTool[];
  readonly grants: readonly ToolGrant[];
  readonly failures: readonly { providerId: string; reason: string }[];
  /**
   * Providers whose configured `stages` exclude this hop's stage, with the
   * stages they were configured for (#2410 gap 2: a misconfigured `stages`
   * must be visible, not silent). The scope-none arm contributes the
   * whole-layer `provider-scope:none` row (permission profile `safe`, or a
   * `rules` scope that resolved no providers).
   */
  readonly skipped: readonly {
    providerId: string;
    reason: "stage-mismatch" | "provider-scope:none";
    stages: readonly string[];
  }[];
  /** Sanitised tools a scoped stage's `admits` rejected (#2410 gap 1). */
  readonly withheld: readonly {
    providerId: string;
    localName: string;
    reason: "not-admitted";
  }[];
  /**
   * Advertised tool name -> owning provider id, carried explicitly so the
   * ledger never has to parse the `<id>__<local>` name apart (a naming
   * convention change would otherwise break telemetry silently).
   */
  readonly providerIdByTool: ReadonlyMap<string, string>;
  /**
   * (providerId, localNames) pairs for the tools that survived sanitisation,
   * the lock and `allowedTools`. Exposed because `Mcp(server:tool)` rules must
   * be matched against the LOCAL name, and `<id>__<local>` is never parsed
   * back apart (src/tools/provider-adapt.ts's header).
   */
  readonly entries: readonly ProviderGrantEntry[];
}

export async function resolveProviderTools(
  providers: readonly ToolProvider[],
  stage: string,
  workdir: string,
  options?: {
    /**
     * Narrows which discovered tools are advertised at all. Applied HERE, not
     * after the fact: a tool a scoped stage did not admit must never be
     * adapted, advertised or granted (spec US-006).
     */
    readonly admits?: (providerId: string, localName: string) => boolean;
  },
): Promise<ResolvedProviderTools> {
  const tools: CodingTool[] = [];
  const entries: { providerId: string; localNames: string[] }[] = [];
  const failures: { providerId: string; reason: string }[] = [];
  const skipped: { providerId: string; reason: "stage-mismatch"; stages: readonly string[] }[] = [];
  const withheld: { providerId: string; localName: string; reason: "not-admitted" }[] = [];
  const providerIdByTool = new Map<string, string>();

  for (const provider of providers) {
    if (!providerAttachesTo(provider, stage)) {
      skipped.push({ providerId: provider.id, reason: "stage-mismatch", stages: provider.stages });
      getSafeLogger()?.debug("mcp", `[provider] ${provider.id} not attached`, { stage, stages: provider.stages });
      continue;
    }
    try {
      const sanitized = sanitizeProviderTools(provider.kind, await provider.tools(workdir));
      const localNames: string[] = [];
      for (const tool of sanitized) {
        if (options?.admits !== undefined && !options.admits(provider.id, tool.localName)) {
          withheld.push({ providerId: provider.id, localName: tool.localName, reason: "not-admitted" });
          continue;
        }
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

  return { tools, grants: expandProviderGrants(entries), failures, skipped, withheld, providerIdByTool, entries };
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
