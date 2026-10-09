/**
 * MCP fixture servers for the shared layer's tests. The in-memory server uses
 * the SDK's low-level Server so tests control raw tool schemas and pages.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

export interface HttpFixture {
  readonly url: string;
  /** Request headers, one entry per HTTP request received. */
  readonly headers: Record<string, string>[];
  readonly deletes: () => number;
  close(): Promise<void>;
}

function flatHeaders(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
  );
}

/** A stateful streamable-HTTP MCP server with one `echo` tool. */
export async function httpServer(): Promise<HttpFixture> {
  const headers: Record<string, string>[] = [];
  let deletes = 0;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    headers.push(flatHeaders(req));
    if (req.method === "DELETE") deletes += 1;
    const id = req.headers["mcp-session-id"];
    let transport = typeof id === "string" ? transports.get(id) : undefined;
    if (transport === undefined) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          if (transport !== undefined) transports.set(sid, transport);
        },
      });
      const server = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }],
      }));
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    deletes: () => deletes,
    async close() {
      for (const t of transports.values()) await t.close().catch(() => undefined);
      http.closeAllConnections(); // Bun: before close(), or close() hangs on an open request
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
