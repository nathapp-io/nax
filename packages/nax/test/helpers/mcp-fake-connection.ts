/**
 * Fake of the SHARED MCP connection (`@nathapp/nax-agent/mcp`), assignable at
 * `_mcpClientDeps.connect`. It generalises the file-local `cannedConnection` in
 * `test/unit/mcp/pool.test.ts` for tests that need an exit to be reported.
 *
 * `exit(reason)` replays the order the shared layer relies on
 * (`Protocol._onclose`, `shared/protocol.js:252`): set the exited state, run the
 * captured `onClose` listeners synchronously, and only then reject every held
 * call with `MCP call <name> failed: the connection is closed` — the message the
 * shared `call()` produces once `life.exited` is set
 * (`packages/nax-agent/src/mcp/connect.ts`).
 */
import {
  McpCallError,
  type McpCallOptions,
  type McpCallResult,
  type McpConnection,
  type McpToolInfo,
} from "@nathapp/nax-agent/mcp";

/** Each fake gets its own pid, so two connections in one test are told apart by their result text. */
let nextPid = 4242;

export interface FakeMcpConnectionOptions {
  /** The pid this connection reports. `null` models a server that reported no pid at connect. */
  pid?: number | null;
  /**
   * Report an exit from inside `onClose` itself — an exit the shared layer saw
   * before anyone listened, which it still reports once.
   */
  exitOnListen?: string;
  /** Hold every `call` open until `release()` settles it, or `exit()` rejects it. */
  holdCalls?: boolean;
  /** Make `close()` reject, as a transport whose reap failed does. */
  closeRejects?: boolean;
  tools?: readonly McpToolInfo[];
}

/** A shared `McpConnection` whose lifecycle a test drives. */
export type FakeMcpConnection = McpConnection & {
  /** The pid reported at connect time; `pid` reads null once the connection exited. */
  readonly connectPid: number | null;
  readonly closeCount: number;
  /** Report the server's exit, with the reason the shared layer would give. */
  exit(reason: string): void;
  /** Settle every held call with its normal result; later calls resolve too. */
  release(): void;
};

const DEFAULT_TOOLS: readonly McpToolInfo[] = [{ name: "t", description: "d", inputSchema: { type: "object" } }];

interface HeldCall {
  readonly name: string;
  readonly settle: (result: McpCallResult) => void;
  readonly reject: (error: unknown) => void;
}

export function makeFakeMcpConnection(options: FakeMcpConnectionOptions = {}): FakeMcpConnection {
  const connectPid = options.pid === undefined ? nextPid++ : options.pid;
  const listeners: ((reason: string) => void)[] = [];
  const held: HeldCall[] = [];
  let exited = false;
  let released = false;
  let closeCount = 0;

  const text = (name: string): string => `ran ${name} (pid ${connectPid})`;
  const resultOf = (name: string): McpCallResult => ({
    text: text(name),
    isError: false,
    bytesBeforeCap: Buffer.byteLength(text(name), "utf8"),
  });
  const closedError = (name: string): McpCallError =>
    new McpCallError(`MCP call ${name} failed: the connection is closed`);

  /** Everything an exit changes, in the SDK's order: state, listeners, then pending calls. */
  const reportExit = (reason: string): void => {
    exited = true;
    for (const listener of listeners) listener(reason);
    for (const call of held.splice(0)) call.reject(closedError(call.name));
  };

  return {
    kind: "stdio",
    tools: options.tools ?? DEFAULT_TOOLS,
    get pid() {
      return exited ? null : connectPid;
    },
    connectPid,
    get closeCount() {
      return closeCount;
    },
    async call(name: string, _input: unknown, _opts: McpCallOptions): Promise<McpCallResult> {
      if (exited) throw closedError(name);
      if (!options.holdCalls || released) return resultOf(name);
      return new Promise<McpCallResult>((settle, reject) => held.push({ name, settle, reject }));
    },
    onClose(listener: (reason: string) => void): void {
      listeners.push(listener);
      // An exit that happened before anyone listened is reported from inside
      // onClose, once (the shared layer's `life.exitReason` check).
      if (options.exitOnListen !== undefined) reportExit(options.exitOnListen);
    },
    async close(): Promise<void> {
      closeCount++;
      if (options.closeRejects) throw new Error("transport reap failed");
    },
    exit(reason: string): void {
      reportExit(reason);
    },
    release(): void {
      released = true;
      for (const call of held.splice(0)) call.settle(resultOf(call.name));
    },
  };
}
