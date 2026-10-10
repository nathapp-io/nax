#!/usr/bin/env node
/**
 * stdio MCP fixture for the shared layer's subprocess tests. Flags:
 *   --stderr <text>     write <text> to stderr at start
 *   --exit-at-start     exit(3) before answering anything (after the stderr text)
 *   --stubborn          ignore SIGTERM and stdin EOF (stays alive until SIGKILL)
 *   --hang-tools-list   answer initialize but never answer tools/list; prints `pid=<pid>` to stderr at start
 * Tools: env(name) -> value of process.env[name]; pid() -> process.pid; crash() -> exit(1).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const text = value("--stderr");
if (text !== undefined) process.stderr.write(text);
if (flag("--exit-at-start")) process.exit(3);
if (flag("--stubborn")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

const server = new Server({ name: "stdio-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
const hangToolsList = flag("--hang-tools-list");
if (hangToolsList) process.stderr.write(`pid=${process.pid}`);
server.setRequestHandler(
  ListToolsRequestSchema,
  hangToolsList
    ? () => new Promise(() => {})
    : async () => ({
        tools: [
          {
            name: "env",
            description: "read an env var",
            inputSchema: { type: "object", properties: { name: { type: "string" } } },
          },
          { name: "pid", description: "the process id", inputSchema: { type: "object", properties: {} } },
          { name: "crash", description: "exit(1)", inputSchema: { type: "object", properties: {} } },
        ],
      }),
);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === "crash") process.exit(1);
  if (name === "pid") return { content: [{ type: "text", text: String(process.pid) }] };
  return { content: [{ type: "text", text: process.env[String(args.name)] ?? "<unset>" }] };
});
const transport = new StdioServerTransport();
if (flag("--stubborn")) transport.onclose = () => {};
await server.connect(transport);
