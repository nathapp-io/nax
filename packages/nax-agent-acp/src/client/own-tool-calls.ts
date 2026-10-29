/**
 * Which tool calls are the session's own embedder tools, read from the agent's
 * structured MCP fields (never a title or display name). Codex reports
 * `rawInput: { server, tool }`, Cursor `rawInput: { providerIdentifier, toolName }`,
 * on a tool_call or a tool_call_update alike. This is authorization evidence, kept
 * apart from tool-events.ts's scrubbed and capped presentation state. The ledger is
 * built for one turn and dropped with it.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { isRecord } from "#src/client/text";

export type McpCallIdentityKind = "codex" | "cursor";

export interface McpCallIdentity {
  readonly toolCallId: string;
  readonly server: string;
  readonly tool: string;
}

const FIELDS: Readonly<Record<McpCallIdentityKind, { readonly server: string; readonly tool: string }>> = {
  codex: { server: "server", tool: "tool" },
  cursor: { server: "providerIdentifier", tool: "toolName" },
};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * The identity a tool_call / tool_call_update reports in its structured rawInput:
 * codex `{ server, tool }`, cursor `{ providerIdentifier, toolName }` (both string).
 * Never reads the title. Undefined for any other update or shape.
 */
export function mcpCallIdentityOf(kind: McpCallIdentityKind, update: SessionUpdate): McpCallIdentity | undefined {
  const record: unknown = update;
  if (!isRecord(record)) return undefined;
  if (record.sessionUpdate !== "tool_call" && record.sessionUpdate !== "tool_call_update") return undefined;
  const raw = record.rawInput;
  if (!nonEmpty(record.toolCallId) || !isRecord(raw)) return undefined;
  const fields = FIELDS[kind];
  const server = raw[fields.server];
  const tool = raw[fields.tool];
  if (!nonEmpty(server) || !nonEmpty(tool)) return undefined;
  return { toolCallId: record.toolCallId, server, tool };
}

export interface OwnToolLedger {
  observe(update: SessionUpdate): void;
  /** True only when every identity seen for this id names serverName and a tool in toolNames. */
  isOwn(toolCallId: string): boolean;
}

/** An id's evidence: its one identity, or `conflict` once two different ones were reported. */
type Evidence = { readonly server: string; readonly tool: string } | "conflict";

export function createOwnToolLedger(input: {
  readonly kind: McpCallIdentityKind;
  readonly serverName: string;
  readonly toolNames: readonly string[];
}): OwnToolLedger {
  const tools: ReadonlySet<string> = new Set(input.toolNames);
  const seen = new Map<string, Evidence>();
  return {
    observe(update) {
      const identity = mcpCallIdentityOf(input.kind, update);
      if (identity === undefined) return;
      const known = seen.get(identity.toolCallId);
      if (known === undefined) {
        seen.set(identity.toolCallId, { server: identity.server, tool: identity.tool });
      } else if (known !== "conflict" && (known.server !== identity.server || known.tool !== identity.tool)) {
        seen.set(identity.toolCallId, "conflict");
      }
    },
    isOwn(toolCallId) {
      const evidence = seen.get(toolCallId);
      return (
        evidence !== undefined &&
        evidence !== "conflict" &&
        evidence.server === input.serverName &&
        tools.has(evidence.tool)
      );
    },
  };
}
