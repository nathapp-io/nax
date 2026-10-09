/**
 * The MCP tools of ONE ACP session (S5-5 spec §3.2, §4.2-§4.5, §5.5). Owned by
 * the registry entry, so connections survive mode and model switches; the tools
 * handed to each reopened S3 session follow the mode (ask: approval always,
 * full: never, none/read: none). A stdio server that exits is marked dead once;
 * its tools then answer with an error result until the session is reopened.
 */
import type { AgentSessionProfile, EmbedderTool, EmbedderToolResult, JSONSchema } from "@nathapp/nax-agent";
import type { McpConnection } from "@nathapp/nax-agent/mcp";
import { displayName } from "#src/server/mcp/parse";
import type { Scrub } from "#src/server/mcp/secrets";
import { displayLine } from "#src/server/translate/tool-kind";

export const MCP_RESULT_BYTES = 1_048_576;
export const MCP_CALL_TIMEOUT_MS = 600_000;

export interface BridgedTool {
  readonly modelName: string;
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
}

export interface LiveServer {
  readonly name: string;
  readonly connection: McpConnection;
}

export interface McpSessionTools {
  readonly connectedCount: number;
  offersTools(mode: AgentSessionProfile): boolean;
  embedderTools(mode: AgentSessionProfile): readonly EmbedderTool[];
  titleFor(modelName: string): string | undefined;
  closeAll(): Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const offers = (mode: AgentSessionProfile): boolean => mode === "ask" || mode === "full";

export const NO_MCP_TOOLS: McpSessionTools = {
  connectedCount: 0,
  offersTools: offers,
  embedderTools: () => [],
  titleFor: () => undefined,
  closeAll: async () => {},
};

export function createMcpSessionTools(input: {
  readonly servers: readonly LiveServer[];
  readonly tools: readonly BridgedTool[];
  readonly scrub: Scrub;
  readonly onDisconnect: (server: string, reason: string) => void;
}): McpSessionTools {
  const dead = new Map<string, string>();
  const byName = new Map(input.servers.map((s) => [s.name, s.connection]));
  let closing: Promise<void> | undefined;

  for (const server of input.servers) {
    server.connection.onClose((reason) => {
      if (closing !== undefined || dead.has(server.name)) return;
      dead.set(server.name, reason);
      input.onDisconnect(server.name, reason);
    });
  }

  async function run(tool: BridgedTool, args: unknown, signal: AbortSignal): Promise<EmbedderToolResult> {
    const shown = displayName(tool.server);
    const reason = dead.get(tool.server);
    if (reason !== undefined)
      return {
        content: input.scrub(`MCP server \`${shown}\` disconnected: ${reason}; reopen the session to reconnect`),
        isError: true,
      };
    const connection = byName.get(tool.server);
    if (connection === undefined) return { content: `MCP server \`${shown}\` is not connected`, isError: true };
    try {
      const result = await connection.call(tool.tool, args, {
        signal,
        timeoutMs: MCP_CALL_TIMEOUT_MS,
        maxBytes: MCP_RESULT_BYTES,
      });
      return { content: input.scrub(result.text), isError: result.isError };
    } catch (error) {
      return { content: input.scrub(`MCP server \`${shown}\`: ${messageOf(error)}`), isError: true };
    }
  }

  const titles = new Map(input.tools.map((t) => [t.modelName, displayLine(`${t.server}: ${t.tool}`)]));

  return {
    connectedCount: input.servers.length,
    offersTools: offers,
    embedderTools(mode) {
      if (!offers(mode)) return [];
      return input.tools.map(
        (tool): EmbedderTool => ({
          name: tool.modelName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          approval: mode === "ask" ? "always" : "never",
          run: (args, ctx) => run(tool, args, ctx.signal),
        }),
      );
    },
    titleFor: (modelName) => titles.get(modelName),
    closeAll() {
      closing ??= Promise.all(input.servers.map((s) => s.connection.close().catch(() => undefined))).then(
        () => undefined,
      );
      return closing;
    },
  };
}
