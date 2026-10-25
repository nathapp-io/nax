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

function status(row: ChatMcpServerRow, state: ChatMcpState): string {
  if (!row.locked) return "not locked (run nax mcp lock)";
  const outcome = lastOutcome(state.events(), row.id);
  const base =
    outcome === undefined
      ? "not connected"
      : outcome.kind === "connected"
        ? `connected, ${outcome.toolCount} tools`
        : outcome.kind === "connect-failed"
          ? `failed: ${outcome.reason}`
          : "not connected";
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
