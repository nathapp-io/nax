/**
 * The fake ACP agent's MCP client (S4-4 D4-k): calls one tool on the session's
 * HTTP MCP server (the `mcpServers` session/new received), the way Claude's
 * adapter would. Erasable TypeScript only: Node runs it with type stripping.
 */
import type { McpServer } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FakeHooks, McpCallStep } from "./script.ts";

interface HttpTarget {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export function httpServerOf(servers: readonly McpServer[]): HttpTarget | undefined {
  for (const server of servers) {
    if ("type" in server && server.type === "http") {
      return { url: server.url, headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
    }
  }
  return undefined;
}

export async function callMcpTool(step: McpCallStep, servers: readonly McpServer[], hooks: FakeHooks): Promise<void> {
  const target = httpServerOf(servers);
  if (target === undefined) {
    hooks.record("mcp-error", { tool: step.tool, message: "no HTTP MCP server" });
    return;
  }
  const client = new Client({ name: "fake-agent", version: "0.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers: target.headers } }),
    );
    const result = await client.callTool({ name: step.tool, arguments: { ...step.input } });
    hooks.record("mcp-result", { tool: step.tool, result });
  } catch (error) {
    hooks.record("mcp-error", { tool: step.tool, message: String(error) });
  } finally {
    await client.close().catch(() => undefined);
  }
}
