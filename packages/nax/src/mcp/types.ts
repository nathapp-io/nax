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
  /**
   * The server's own `readOnlyHint: true`, carried from the shared layer. Untrusted
   * on its own: `createMcpProviders` honours it only when the lock also lists the tool.
   */
  readonly readOnly?: true;
}

export interface McpCallResult {
  readonly content: string;
  /** Error AS DATA (ADR-029 section 5) — never a throw for a server-side failure. */
  readonly isError: boolean;
  /** Result size before the maxBytes slice, so elision is visible in the ledger. */
  readonly bytesPreTruncation: number;
  /**
   * Whether the call reached the server at all. Absent means it may have: a deadline or a
   * transport error is an interruption of something that was sent. `"never"` is the other fact —
   * no live connection could take the call, so nothing was written to the wire and a caller
   * holding a write it may not repeat can safely send it again.
   */
  readonly dispatch?: "never";
}

export interface McpConnection {
  readonly instructions?: string;
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
  /**
   * stdio only, as in the shared layer: called once when the process exits
   * without `close()` having been called — including when the exit happened
   * before this listener was registered.
   */
  onClose(listener: (reason: string) => void): void;
  close(): Promise<void>;
}
