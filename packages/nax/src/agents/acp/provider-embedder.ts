/**
 * nax#2444 D1/D3: provider tools cross the ACP boundary as EmbedderTools, and
 * only for agents whose registry entry declares a pre-approval channel
 * (claudeCode.allowedTools) or an MCP call identity (codex, cursor). Delivery is the deny/ask enforcement point on
 * that path, so the hop's already-filtered set is served as-is; everything
 * here is pure and null-safe so the adapter stays testable without a process.
 */

import type {
  CodingTool,
  EmbedderTool,
  OpenSessionOpts,
  ToolSurfaceDraft,
  ToolSurfaceRecord,
} from "@nathapp/nax-agent";
import type { AcpAgentName } from "@nathapp/nax-agent-acp/client";
import { registryEntry } from "@nathapp/nax-agent-acp/client";
import { finishToolSurface } from "../tool-surface";
import type { AcpProfile } from "./profile-map";

/**
 * Per-call budget handed to provider tools as `ToolRunContext.maxBytes` — the
 * same advisory cap native callers pass. Honoring it is the TOOL's choice
 * (external MCP tools decide), and the loopback host returns result content
 * uncapped, so this bounds cooperative tools, not the transport.
 */
const ACP_MCP_RESULT_MAX_BYTES = 1_048_576;

/** A provider tool the agent calls as `mcp__<session server name>__<name>`, pre-approved at open. */
export function toEmbedderTools(tools: readonly CodingTool[], workdir: string): EmbedderTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // Policy-granted before they were advertised: no per-call approval.
    approval: "never" as const,
    run: async (input: unknown, ctx: { signal: AbortSignal }) => {
      try {
        const result = await tool.run((input ?? {}) as Record<string, unknown>, {
          root: workdir,
          resolvedPaths: [],
          maxBytes: ACP_MCP_RESULT_MAX_BYTES,
          maxFileBytes: ACP_MCP_RESULT_MAX_BYTES,
          signal: ctx.signal,
        });
        return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
      } catch (error) {
        // A throw must reach the model as an MCP error result, never crash the turn.
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  }));
}

/** The opts fields the delivery decision reads. */
type DeliveryOpts = Pick<OpenSessionOpts, "providerTools" | "toolSurface" | "workdir">;

/**
 * The capability gate (D3): an agent with neither a pre-approval channel nor an
 * MCP call identity would fail its open if handed tools (`AGENT_SESSION_CAPABILITY_UNSUPPORTED`), so the
 * tools are dropped instead and the skip recorded in the surface. Pure — the
 * session and the open context may finalize independently and agree.
 */
export function finalizeAcpSurface(
  agent: AcpAgentName,
  opts: DeliveryOpts,
  profile: AcpProfile,
): { tools: readonly EmbedderTool[]; surface: ToolSurfaceRecord | undefined } {
  const capable = registryCapable(agent);
  if (opts.toolSurface === undefined) {
    return { tools: capable ? toEmbedderTools(opts.providerTools ?? [], opts.workdir) : [], surface: undefined };
  }
  const draft: ToolSurfaceDraft = opts.toolSurface;
  if (!capable) {
    return {
      tools: [],
      surface: finishToolSurface(
        {
          ...draft,
          advertised: [],
          skippedProviders: [...draft.skippedProviders, { id: agent, reason: "mcp-pre-approval-unsupported" }],
        },
        "acp",
        profile,
      ),
    };
  }
  return {
    tools: toEmbedderTools(opts.providerTools ?? [], opts.workdir),
    surface: finishToolSurface(draft, "acp", profile),
  };
}

function registryCapable(agent: AcpAgentName): boolean {
  const entry = registryEntry(agent);
  return entry?.preApproval !== undefined || entry?.mcpCallIdentity !== undefined;
}
