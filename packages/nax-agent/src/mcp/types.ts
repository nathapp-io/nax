/** Vocabulary of the shared MCP connection layer (S5-5 spec §3.1). Free of SDK types. */
import type { JSONSchema } from "#src/session/tool-descriptor";

export type McpTransportConfig =
  | {
      readonly kind: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
    }
  | { readonly kind: "http"; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
}

export interface McpCallResult {
  readonly text: string;
  readonly isError: boolean;
  readonly bytesBeforeCap: number;
}

export interface McpCallOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface McpConnection {
  readonly kind: "stdio" | "http";
  readonly tools: readonly McpToolInfo[];
  /** Server-side tool errors are `isError` results; transport failures throw McpCallError. */
  call(name: string, input: unknown, opts: McpCallOptions): Promise<McpCallResult>;
  /** stdio only: called once when the process exits without close() having been called. */
  onClose(listener: (reason: string) => void): void;
  /** Idempotent. Resolves when the transport, and for stdio the process, is gone. */
  close(): Promise<void>;
}

export interface ConnectMcpOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly clientInfo: { readonly name: string; readonly version: string };
  /** stdio: how long close() waits for the process before SIGKILL. Default 3000. */
  readonly closeGraceMs?: number;
}
