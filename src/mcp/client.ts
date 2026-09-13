/**
 * One stdio MCP connection, wrapped so nothing above this file imports the SDK.
 *
 * Two traps the SDK's defaults set, both handled here:
 *
 * 1. `StdioClientTransport` uses `getDefaultEnvironment()` ONLY when `env` is
 *    absent. Passing `{ NAX: "1" }` would therefore hand the server an
 *    environment with no PATH, and it would fail to exec its own helpers. The
 *    configured env is an OVERLAY on the default, never a replacement.
 * 2. `stderr` defaults to `"inherit"`, which would interleave a server's
 *    diagnostics into nax's TUI. Piped and dropped instead.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONSchema } from "@/context/engine";
import { NaxError } from "@/errors";
import type { McpConnection, McpToolDescriptor } from "./types";

/** Injectable seam, mirroring `_argvExecDeps` — lets the unit tests run without a subprocess. */
export const _mcpClientDeps = {
  createTransport: (params: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): { pid: number | null; close(): Promise<void> } => new StdioClientTransport({ ...params, stderr: "pipe" }),
  createClient: (): McpClientLike => new Client({ name: "nax", version: "1" }),
};

/**
 * The slice of the SDK client this wrapper uses.
 *
 * Declared structurally rather than importing the SDK's own types, so a fake in
 * a test satisfies it without a cast — `as never` is lint-banned repo-wide
 * (biome-plugins/no-as-never.grit). `Client` satisfies this shape, so the seam
 * needs no assertion either.
 */
export interface McpClientLike {
  // `unknown` for the SDK-typed parameters, and METHOD syntax rather than
  // arrow-property syntax, both deliberately: method parameters compare
  // bivariantly, which is what lets the real `Client` (whose `connect` takes a
  // `Transport`) satisfy this interface while a test fake taking nothing also
  // satisfies it. Naming the SDK's own types here would drag them above this
  // file; `never` would make the parameter unusable.
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
  listTools(params?: unknown, options?: { timeout?: number }): Promise<{ tools: unknown[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface RawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

function toDescriptors(tools: readonly unknown[]): readonly McpToolDescriptor[] {
  const out: McpToolDescriptor[] = [];
  for (const raw of tools) {
    const tool = raw as RawTool;
    if (typeof tool.name !== "string" || tool.name.length === 0) continue;
    out.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: (tool.inputSchema ?? {}) as JSONSchema,
    });
  }
  return out;
}

/** Truncate to a byte ceiling without splitting a code point (mirrors provider-sanitize). */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

function renderContent(result: unknown): { text: string; isError: boolean } {
  const body = (result ?? {}) as { content?: unknown; isError?: unknown };
  const blocks = Array.isArray(body.content) ? body.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else parts.push(`[${String(typed.type ?? "unknown")} content omitted]`);
  }
  return { text: parts.join("\n"), isError: body.isError === true };
}

export async function connectMcpServer(args: {
  serverId: string;
  workdir: string;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  connectTimeoutMs: number;
}): Promise<McpConnection> {
  const transport = _mcpClientDeps.createTransport({
    command: args.command,
    args: [...args.args],
    // Trap 1 above: overlay, never replace.
    env: { ...getDefaultEnvironment(), ...args.env },
    cwd: args.workdir,
  });
  const client = _mcpClientDeps.createClient();

  try {
    await client.connect(transport, { timeout: args.connectTimeoutMs });
  } catch (error) {
    await transport.close().catch(() => {});
    throw new NaxError(
      `MCP server "${args.serverId}" failed to connect at ${args.workdir}: ${String(error)}`,
      "MCP_CONNECT_FAILED",
      { stage: "tools" },
    );
  }

  return {
    serverId: args.serverId,
    workdir: args.workdir,
    get pid() {
      return transport.pid ?? null;
    },
    async listTools() {
      const response = await client.listTools(undefined, { timeout: args.connectTimeoutMs });
      return toDescriptors(response.tools ?? []);
    },
    async callTool(name, input, opts) {
      const raw = await client.callTool({ name, arguments: input }, undefined, { timeout: opts.timeoutMs });
      const { text, isError } = renderContent(raw);
      return {
        content: truncateToBytes(text, opts.maxBytes),
        isError,
        bytesPreTruncation: Buffer.byteLength(text, "utf8"),
      };
    },
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}
