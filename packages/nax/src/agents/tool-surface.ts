/**
 * The MCP tool-surface record (#2410 D4) and the ACP delivery filter (#2444 D4).
 *
 * The draft is the transport-less evidence of what a session was OFFERED; the
 * record stamps the transport and, on ACP, the narrowed profile. The delivery
 * filter exists because claude pre-approval means a delivered tool NEVER
 * reaches a permission round trip — so an `Mcp(...)` deny or ask rule must be
 * enforced at delivery time, the only point on that path where it still can be.
 */
import {
  mcpRuleAdmits,
  type CodingTool,
  type ResolvedProviderTools,
  type ToolSurfaceDraft,
  type ToolSurfaceRecord,
} from "@nathapp/nax-agent";

export interface ToolSurfaceDraftInput {
  readonly stage: string;
  readonly declaredTools: readonly string[];
  readonly providerResult: ResolvedProviderTools;
  /** Whole-layer skips recorded by the caller (e.g. `provider-scope:none`). */
  readonly extraSkipped?: readonly { id: string; reason: string }[];
  /** Per-tool rows the caller withheld after resolution (deny/ask-ruled on ACP). */
  readonly extraWithheld?: readonly { providerId: string; name: string; reason: string }[];
}

export function buildToolSurfaceDraft(input: ToolSurfaceDraftInput): ToolSurfaceDraft {
  return {
    stage: input.stage,
    declaredTools: [...input.declaredTools],
    advertised: input.providerResult.entries
      .filter((entry) => entry.localNames.length > 0)
      .map((entry) => ({ providerId: entry.providerId, names: [...entry.localNames] })),
    withheld: [
      ...input.providerResult.withheld.map((row) => ({
        providerId: row.providerId,
        name: row.localName,
        reason: row.reason,
      })),
      ...(input.extraWithheld ?? []),
    ],
    skippedProviders: [
      ...input.providerResult.skipped.map((row) => ({
        id: row.providerId,
        reason: row.reason,
        stages: row.stages,
      })),
      ...(input.extraSkipped ?? []),
    ],
    failures: input.providerResult.failures.map((row) => ({ ...row })),
  };
}

export function finishToolSurface(
  draft: ToolSurfaceDraft,
  transport: "native" | "acp",
  profile?: "full" | "read",
): ToolSurfaceRecord {
  return { ...draft, transport, ...(profile === undefined ? {} : { profile }) };
}

export function filterAcpDelivery(
  providerResult: ResolvedProviderTools,
  rules: { deniedMcp: readonly string[]; askedMcp: readonly string[] },
): {
  tools: readonly CodingTool[];
  withheldExtra: readonly { providerId: string; name: string; reason: "denied" | "ask-ruled" }[];
} {
  const tools: CodingTool[] = [];
  const withheldExtra: { providerId: string; name: string; reason: "denied" | "ask-ruled" }[] = [];
  for (const adapted of providerResult.tools) {
    const providerId = providerResult.providerIdByTool.get(adapted.name);
    const localName = providerId === undefined ? adapted.name : adapted.name.slice(providerId.length + 2);
    if (rules.deniedMcp.length > 0 && providerId !== undefined && mcpRuleAdmits(rules.deniedMcp, providerId, localName)) {
      withheldExtra.push({ providerId, name: localName, reason: "denied" });
      continue;
    }
    if (rules.askedMcp.length > 0 && providerId !== undefined && mcpRuleAdmits(rules.askedMcp, providerId, localName)) {
      withheldExtra.push({ providerId, name: localName, reason: "ask-ruled" });
      continue;
    }
    tools.push(adapted);
  }
  return { tools, withheldExtra };
}
