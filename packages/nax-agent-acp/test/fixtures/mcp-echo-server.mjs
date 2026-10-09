import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "echo text",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
    { name: "secret", description: "print API_TOKEN", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "secret") return { content: [{ type: "text", text: `token=${process.env.API_TOKEN}` }] };
  return { content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }] };
});
await server.connect(new StdioServerTransport());
