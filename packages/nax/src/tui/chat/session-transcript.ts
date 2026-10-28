/** Opening rows shared by the screen's initial render and session-id transitions. */
import { type ChatHost, sessionTitleText } from "@/chat";
import type { McpServerEvent } from "@/mcp";
import { replayHistory } from "./history-replay";
import type { TranscriptEntry } from "./transcript-model";

/** Teardown (`closed`) is not a connection status. */
function lastServerEvent(events: readonly McpServerEvent[], id: string): McpServerEvent | undefined {
  return events.findLast((event) => event.serverId === id);
}

function welcomeEntry(host: ChatHost): TranscriptEntry {
  const catalog = host.catalog;
  const servers = host.mcp?.servers ?? [];
  const events = host.mcp?.events() ?? [];
  return {
    kind: "welcome",
    skills: catalog?.skills.length ?? 0,
    commands: catalog?.commands.length ?? 0,
    agents: catalog?.agents.length ?? 0,
    mcpServers: servers.length,
    mcpConnected: servers.filter((server) => lastServerEvent(events, server.id)?.kind === "connected").length,
  };
}

export function sessionTranscript(host: ChatHost): readonly TranscriptEntry[] {
  const replayed = replayHistory(host.history?.() ?? { messages: [] });
  const rows = [welcomeEntry(host), ...replayed];
  if (replayed.length > 0) {
    const { meta, sessionId } = host.current();
    rows.push({ kind: "notice", text: `resumed ${sessionTitleText(meta.title, sessionId)}` });
  }
  return rows;
}
