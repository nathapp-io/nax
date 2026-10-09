/** MCP notice texts (S5-5 spec §6, §6.2). Lines come from client config and servers: stripped and scrubbed. */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import { stripControl, stripInvisible } from "#src/client/text";
import type { Scrub } from "#src/server/mcp/secrets";
import { announce } from "#src/server/translate/notice";

export const OPEN_NOTICE_TITLE = "Some MCP servers or tools are not available";

const clean = (text: string, scrub: Scrub): string => scrub(stripInvisible(stripControl(text)));

export function openNotice(notices: boolean, lines: readonly string[], scrub: Scrub): SessionUpdate | undefined {
  if (lines.length === 0) return undefined;
  return announce(notices, "warning", OPEN_NOTICE_TITLE, lines.map((line) => clean(line, scrub)).join("\n"));
}

export function modeNotice(notices: boolean, mode: AgentSessionProfile): SessionUpdate {
  const title = `MCP tools are off in ${mode} mode`;
  // As an agent message the title and advice are one sentence.
  if (!notices) return announce(false, "info", `${title}; switch to ask or full to use them.`);
  return announce(true, "info", title, "Switch to ask or full to use them.");
}

export function disconnectNotice(notices: boolean, server: string, reason: string, scrub: Scrub): SessionUpdate {
  return announce(
    notices,
    "warning",
    `MCP server \`${clean(server, scrub)}\` disconnected`,
    `${clean(reason, scrub)}; reopen the session to reconnect`,
  );
}
