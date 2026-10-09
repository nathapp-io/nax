/**
 * MCP fixture servers for the shared layer's tests. The in-memory server uses
 * the SDK's low-level Server so tests control raw tool schemas and pages.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FixtureCtx {
  readonly signal: AbortSignal;
  /** Sends notifications/progress for this call; a no-op when the client sent no progressToken. */
  progress(n: number): Promise<void>;
}

export interface FixtureTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly run?: (args: Record<string, unknown>, ctx: FixtureCtx) => Promise<CallToolResult>;
}

export interface InMemoryFixture {
  /** The client side, for _mcpTransportDeps.create. */
  readonly clientTransport: InMemoryTransport;
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly server: Server;
}

/** `pageSize` splits tools/list into pages to exercise nextCursor. */
export async function inMemoryServer(tools: readonly FixtureTool[], pageSize = 1000): Promise<InMemoryFixture> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const start = Number(request.params?.cursor ?? "0");
    const page = tools.slice(start, start + pageSize).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));
    const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
    return { tools: page, ...(next !== undefined ? { nextCursor: next } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    calls.push({ name: request.params.name, args });
    const token = request.params._meta?.progressToken;
    const ctx: FixtureCtx = {
      signal: extra.signal,
      progress: async (n) => {
        if (token === undefined) return;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: n },
        });
      },
    };
    const tool = tools.find((t) => t.name === request.params.name);
    if (tool?.run === undefined) return { content: [{ type: "text", text: `ran ${request.params.name}` }] };
    return tool.run(args, ctx);
  });
  await server.connect(serverTransport);
  return { clientTransport, calls, server };
}
