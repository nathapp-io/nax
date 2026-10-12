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
  type CodingTool,
  mcpRuleAdmits,
  type ResolvedProviderTools,
  type ToolSurfaceDraft,
  type ToolSurfaceRecord,
} from "@nathapp/nax-agent";
import type { CodingToolSupport } from "@nathapp/nax-agent/internal";

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
  // A tool the delivery filter withheld (deny/ask-ruled) was never served on
  // ACP, so it must not read as advertised (#2410: the record says what the
  // model actually saw).
  const extraWithheld = input.extraWithheld ?? [];
  const notServed = new Set(extraWithheld.map((row) => `${row.providerId}__${row.name}`));
  return {
    stage: input.stage,
    declaredTools: [...input.declaredTools],
    advertised: input.providerResult.entries
      .filter((entry) => entry.localNames.length > 0)
      .map((entry) => ({
        providerId: entry.providerId,
        names: entry.localNames.filter((name) => !notServed.has(`${entry.providerId}__${name}`)),
      }))
      .filter((entry) => entry.names.length > 0),
    withheld: [
      ...input.providerResult.withheld.map((row) => ({
        providerId: row.providerId,
        name: row.localName,
        reason: row.reason,
      })),
      ...extraWithheld,
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
    if (
      rules.deniedMcp.length > 0 &&
      providerId !== undefined &&
      mcpRuleAdmits(rules.deniedMcp, providerId, localName)
    ) {
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

/** One resolve's surface evidence: the native record, the ACP draft and delivery. */
export interface ProviderSurface {
  readonly delivery: ReturnType<typeof filterAcpDelivery> | undefined;
  readonly acpDraft: ReturnType<typeof buildToolSurfaceDraft> | undefined;
  readonly toolSurface: ReturnType<typeof finishToolSurface> | undefined;
}

export const NO_PROVIDER_SURFACE: ProviderSurface = {
  delivery: undefined,
  acpDraft: undefined,
  toolSurface: undefined,
};

/**
 * nax#2410 D4 + nax#2444 D4: the native surface record, the deny/ask-filtered
 * ACP delivery set and the ACP draft share one signal — any provider evidence
 * at all (advertised, skipped, withheld or failed). With none, both extra
 * fields are absent so a plain run costs nothing.
 */
export function resolveProviderSurface(args: {
  providerResult: ResolvedProviderTools;
  deniedMcp: readonly string[];
  askedMcp: readonly string[];
  stage: string;
  declaredTools: readonly string[];
}): ProviderSurface {
  const { providerResult } = args;
  const signal =
    providerResult.entries.length > 0 ||
    providerResult.skipped.length > 0 ||
    providerResult.withheld.length > 0 ||
    providerResult.failures.length > 0;
  if (!signal) return NO_PROVIDER_SURFACE;
  const delivery = filterAcpDelivery(providerResult, { deniedMcp: args.deniedMcp, askedMcp: args.askedMcp });
  return {
    delivery,
    acpDraft: buildToolSurfaceDraft({
      stage: args.stage,
      declaredTools: args.declaredTools,
      providerResult,
      extraWithheld: delivery.withheldExtra,
    }),
    toolSurface: finishToolSurface(
      buildToolSurfaceDraft({ stage: args.stage, declaredTools: args.declaredTools, providerResult }),
      "native",
    ),
  };
}

/** Attaches the ACP delivery fields to the resolved support; no draft means nothing to attach. */
export function attachAcpDelivery(support: CodingToolSupport, surface: ProviderSurface): CodingToolSupport {
  if (surface.acpDraft === undefined || surface.delivery === undefined) return support;
  return {
    ...support,
    ...(surface.toolSurface !== undefined ? { toolSurface: surface.toolSurface } : {}),
    acpDelivery: {
      tools: surface.delivery.tools,
      surface: surface.acpDraft,
    },
  };
}
