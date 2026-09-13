#!/usr/bin/env bun
/**
 * Minimal real MCP server for tests: real protocol, real subprocess, no network.
 *
 * Env switches:
 *   FAKE_MCP_TOOL_SUFFIX  extra tool advertised, to simulate a server upgrade
 *   FAKE_MCP_DIE_ON_CALL  exit(1) instead of answering the first tools/call
 *   FAKE_MCP_HANG_ON_CALL never answer a tools/call (tests the deadline)
 *   FAKE_MCP_BIG_RESULT   answer with this many bytes (tests truncation)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake", version: "1" }, { capabilities: { tools: {} } });

const tools = [
  {
    name: "echo",
    description: "Echoes cwd and input",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
  ...(process.env.FAKE_MCP_TOOL_SUFFIX
    ? [
        {
          name: `extra_${process.env.FAKE_MCP_TOOL_SUFFIX}`,
          description: "Added later",
          inputSchema: { type: "object" },
        },
      ]
    : []),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (process.env.FAKE_MCP_DIE_ON_CALL) process.exit(1);
  if (process.env.FAKE_MCP_HANG_ON_CALL) await new Promise(() => {});
  const big = process.env.FAKE_MCP_BIG_RESULT;
  const text = big
    ? "x".repeat(Number(big))
    : `cwd=${process.cwd()} q=${String((request.params.arguments as { q?: string })?.q ?? "")}`;
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
