/**
 * Connects one ACP session's MCP servers (S5-5 spec §4.1, §5.1-§5.3): all in
 * parallel through the shared layer, each bounded by the connect timeout; a
 * failure skips that server with a scrubbed notice line (stderr tail included).
 * Tools are taken server by server in list order up to MCP_MAX_TOOLS, shaped
 * and named. If the signal aborts (shutdown), everything connected is closed.
 */
import type { connectMcp, McpToolInfo } from "@nathapp/nax-agent/mcp";
import { McpConnectError } from "@nathapp/nax-agent/mcp";
import { type NamedTool, nameTools, type ToolRef } from "#src/server/mcp/naming";
import { cappedItems, displayName, type ParsedServer, type ParsedServers } from "#src/server/mcp/parse";
import { mcpSecrets, type Scrub, scrubber } from "#src/server/mcp/secrets";
import {
  type BridgedTool,
  createMcpSessionTools,
  type LiveServer,
  type McpSessionTools,
  NO_MCP_TOOLS,
} from "#src/server/mcp/session-tools";
import { shapeDescription, shapeSchema } from "#src/server/mcp/tool-shape";

export const MCP_MAX_TOOLS = 200;

export interface SessionMcp {
  readonly tools: McpSessionTools;
  readonly noticeLines: readonly string[];
  readonly scrub: Scrub;
}

export interface ConnectSessionMcpInput {
  readonly parsed: ParsedServers;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onDisconnect: (server: string, reason: string) => void;
}

export type ConnectSessionMcp = (input: ConnectSessionMcpInput) => Promise<SessionMcp>;

export interface McpConnectorDeps {
  readonly connect: typeof connectMcp;
  readonly timeoutMs: number;
  readonly clientVersion: string;
  readonly closeGraceMs?: number;
}

export const connectNothing: ConnectSessionMcp = async () => ({
  tools: NO_MCP_TOOLS,
  noticeLines: [],
  scrub: (t) => t,
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function failureLine(server: ParsedServer, error: unknown): string {
  const tail =
    error instanceof McpConnectError && error.stderrTail !== undefined ? ` (stderr: ${error.stderrTail})` : "";
  return `\`${displayName(server.name)}\`: ${messageOf(error)}${tail}`;
}

export interface Candidate extends ToolRef {
  readonly info: McpToolInfo;
}

function collectTools(live: readonly LiveServer[], lines: string[]): Candidate[] {
  const kept: Candidate[] = [];
  const overLimit: string[] = [];
  const schemaDropped: string[] = [];
  for (const server of live) {
    for (const info of server.connection.tools) {
      const shaped = shapeSchema(info.inputSchema);
      if (!shaped.ok) {
        schemaDropped.push(
          `\`${displayName(server.name)}\`: tool \`${displayName(info.name)}\` dropped: ${shaped.reason}`,
        );
      } else if (kept.length >= MCP_MAX_TOOLS) {
        overLimit.push(`\`${displayName(server.name)}\`: ${displayName(info.name)}`);
      } else {
        kept.push({ server: server.name, tool: info.name, info: { ...info, inputSchema: shaped.schema } });
      }
    }
  }
  lines.push(...cappedItems(schemaDropped));
  if (overLimit.length > 0)
    lines.push(
      `MCP tool limit (${MCP_MAX_TOOLS}) reached; dropped ${overLimit.length} tools: ${cappedItems(overLimit).join("; ")}`,
    );
  return kept;
}

/** Names a candidate into what the model sees; candidates without matching info are skipped. */
export function bridgeTools(candidates: readonly Candidate[], named: readonly NamedTool[]): BridgedTool[] {
  const infoOf = new Map(candidates.map((c) => [`${c.server}\0${c.tool}`, c.info]));
  return named.flatMap((n) => {
    const info = infoOf.get(`${n.server}\0${n.tool}`);
    if (info === undefined) return [];
    return [
      {
        modelName: n.modelName,
        server: n.server,
        tool: n.tool,
        description: shapeDescription(displayName(n.server), info.description),
        inputSchema: info.inputSchema,
      },
    ];
  });
}

function bridged(candidates: readonly Candidate[], lines: string[]): BridgedTool[] {
  const { named, dropped } = nameTools(candidates);
  lines.push(
    ...cappedItems(
      dropped.map((ref) => `\`${displayName(ref.server)}\`: tool \`${displayName(ref.tool)}\` dropped: duplicate name`),
    ),
  );
  return bridgeTools(candidates, named);
}

export function createMcpConnector(deps: McpConnectorDeps): ConnectSessionMcp {
  return async (input) => {
    const scrub = scrubber(mcpSecrets(input.parsed.servers));
    const settled = await Promise.allSettled(
      input.parsed.servers.map((server) =>
        deps.connect(
          server.kind === "stdio"
            ? { kind: "stdio", command: server.command, args: server.args, env: server.env, cwd: input.cwd }
            : { kind: "http", url: server.url, headers: server.headers },
          {
            signal: input.signal,
            timeoutMs: deps.timeoutMs,
            clientInfo: { name: "nax-agent", version: deps.clientVersion },
            ...(deps.closeGraceMs !== undefined ? { closeGraceMs: deps.closeGraceMs } : {}),
          },
        ),
      ),
    );
    const live: LiveServer[] = [];
    const lines: string[] = [...input.parsed.skipped];
    input.parsed.servers.forEach((server, i) => {
      const result = settled[i];
      if (result?.status === "fulfilled") live.push({ name: server.name, connection: result.value });
      else if (result !== undefined) lines.push(failureLine(server, result.reason));
    });
    if (input.signal.aborted) {
      await Promise.all(live.map((s) => s.connection.close().catch(() => undefined)));
      throw new McpConnectError("MCP connect aborted: the server is shutting down");
    }
    const tools = bridged(collectTools(live, lines), lines);
    return {
      tools: createMcpSessionTools({ servers: live, tools, scrub, onDisconnect: input.onDisconnect }),
      noticeLines: lines.map(scrub),
      scrub,
    };
  };
}
