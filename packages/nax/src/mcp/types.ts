/**
 * Vocabulary for the MCP client layer.
 *
 * Deliberately free of SDK types: everything above this file speaks nax's own
 * shapes, so swapping transports (spec R10 defers streamable HTTP) or the SDK
 * itself touches `client.ts` alone.
 */
import type { JSONSchema } from "@/context/engine";

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
}

export interface McpCallResult {
  readonly content: string;
  /** Error AS DATA (ADR-029 section 5) — never a throw for a server-side failure. */
  readonly isError: boolean;
  /** Result size before the maxBytes slice, so elision is visible in the ledger. */
  readonly bytesPreTruncation: number;
}

export interface McpConnection {
  readonly serverId: string;
  readonly workdir: string;
  /** Child pid, for the runtime's PidRegistry. Null before start or after close. */
  readonly pid: number | null;
  listTools(): Promise<readonly McpToolDescriptor[]>;
  callTool(
    name: string,
    input: Record<string, unknown>,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}
