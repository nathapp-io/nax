/** The text `/mcp` shows: one line per attached server, then the diagnostics. */
import type { McpServerEvent } from "@/mcp";
import type { ResourceDiagnostic } from "@/resources";
import type { ChatMcpServerRow, ChatMcpState } from "./chat-mcp";

const NO_SERVERS = "(no MCP servers)";

function sourceLabel(row: ChatMcpServerRow): string {
  return row.source === "plugin" && row.plugin !== undefined ? `plugin ${row.plugin}` : row.source;
}

/** The server's latest connection outcome; `closed` is teardown, not a status. */
function lastOutcome(events: readonly McpServerEvent[], id: string): McpServerEvent | undefined {
  return events.findLast((event) => event.serverId === id && event.kind !== "closed");
}

/** One outcome as a status; anything that is not up or failed to come up is down. */
function outcomeLabel(outcome: McpServerEvent | undefined): string {
  if (outcome?.kind === "connected") return `connected, ${outcome.toolCount} tools`;
  if (outcome?.kind === "connect-failed") return `failed: ${outcome.reason}`;
  // The reason is the pool's already-redacted text, so it is safe to show.
  if (outcome?.kind === "disconnected") return `disconnected: ${outcome.reason}`;
  return "not connected";
}

function status(row: ChatMcpServerRow, state: ChatMcpState): string {
  if (!row.locked) return "not locked (run nax mcp lock)";
  const base = outcomeLabel(lastOutcome(state.events(), row.id));
  const withheld = state.withheld().filter((entry) => entry.serverId === row.id).length;
  return withheld > 0 ? `${base}, ${withheld} withheld (run nax mcp lock)` : base;
}

function diagnosticLine(diagnostic: ResourceDiagnostic): string {
  return `${diagnostic.severity}  ${diagnostic.path}  ${diagnostic.message}`;
}

export function formatMcpListing(state: ChatMcpState | undefined): string {
  if (state === undefined) return NO_SERVERS;
  const servers = state.servers.map((row) => `${row.id}  ${sourceLabel(row)}  ${row.transport}  ${status(row, state)}`);
  return [...(servers.length > 0 ? servers : [NO_SERVERS]), ...state.diagnostics.map(diagnosticLine)].join("\n");
}
