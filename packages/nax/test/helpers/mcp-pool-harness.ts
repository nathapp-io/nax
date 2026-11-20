/**
 * The seam and the fixtures the three exit-driven pool suites share:
 * `pool-reconnect`, `pool-budget` and `pool-retry` all configure the same stdio
 * server, drive `createMcpPool` through a faked `_mcpClientDeps.connect`, and
 * read the same connection/event shapes back. Copying that wiring into each file
 * is what `.nax/rules/test-helpers.md` and `forbidden-patterns-tests.md` forbid,
 * so it lives here (`pool.test.ts` predates it and keeps its own `fakeSdk`).
 *
 * `fakeMcpConnect` records what each attempt received and hands back the
 * connection named for that attempt — the seam a case overrides per attempt
 * (attempt 1 holds calls, later ones answer directly) or turns into a rejection
 * (a reconnect whose every connect attempt fails).
 */
import type { ConnectMcpOptions, McpCallOptions, McpTransportConfig } from "@nathapp/nax-agent/mcp";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import type { McpServerEvent } from "@/mcp/pool";
import { assertDefined } from "./assert-defined";
import { type FakeMcpConnection, makeFakeMcpConnection } from "./mcp-fake-connection";

/** nax run only ever configures stdio servers; this is the variant the faked seam receives. */
export type StdioConfig = Extract<McpTransportConfig, { kind: "stdio" }>;

/** The one server every pool case configures; a case spreads it to vary a single field. */
export const MCP_TEST_SERVERS: Readonly<Record<string, McpServerConfig>> = {
  memory: { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true },
};

/** The reason the shared layer reports for a stdio server whose process exited. */
export const MCP_EXIT_REASON = "the server process exited";

/** Call options wide enough that only the cases naming a deadline reach one. */
export const MCP_CALL_OPTS: { readonly timeoutMs: number; readonly maxBytes: number } = {
  timeoutMs: 1000,
  maxBytes: 1000,
};

/** One call the adapter forwarded to a shared connection. */
export interface McpDispatch {
  readonly name: string;
  readonly input: unknown;
  readonly opts: McpCallOptions;
}

export interface McpConnectHarness {
  /** Every connection handed back, in attempt order. */
  readonly connections: FakeMcpConnection[];
  /** The config each attempt received; its length is the total connect count. */
  readonly configs: StdioConfig[];
  /** The calls each connection received, indexed by attempt - 1. Empty unless `recordDispatches`. */
  readonly dispatches: McpDispatch[][];
}

export interface McpConnectHarnessOptions {
  /** Record what the adapter forwards to each connection, attempt by attempt. */
  recordDispatches?: boolean;
}

/** The seam as it was before a case faked it. */
const realConnect = _mcpClientDeps.connect;

/** Put the faked connect seam back; pair it with `afterEach`. */
export function restoreMcpConnectSeam(): void {
  _mcpClientDeps.connect = realConnect;
}

/** Records what the adapter forwards, without changing what the fake does with it. */
function recordDispatches(connection: FakeMcpConnection): McpDispatch[] {
  const dispatches: McpDispatch[] = [];
  const send = connection.call.bind(connection);
  connection.call = async (name, input, opts) => {
    dispatches.push({ name, input, opts });
    return send(name, input, opts);
  };
  return dispatches;
}

/**
 * Fakes the shared connect seam: each attempt records its config and hands back
 * the connection `make` names for it — a throw there fails that attempt, as a
 * connect whose every attempt fails does.
 */
export function fakeMcpConnect(
  make: (attempt: number) => FakeMcpConnection = () => makeFakeMcpConnection(),
  options: McpConnectHarnessOptions = {},
): McpConnectHarness {
  const connections: FakeMcpConnection[] = [];
  const configs: StdioConfig[] = [];
  const dispatches: McpDispatch[][] = [];
  Object.assign(_mcpClientDeps, {
    connect: async (config: StdioConfig, connectOptions: ConnectMcpOptions) => {
      configs.push(config);
      const connection = make(configs.length);
      connections.push(connection);
      dispatches.push(options.recordDispatches === true ? recordDispatches(connection) : []);
      // The real layer reports the spawn once the stdio transport starts, before the handshake.
      if (connection.connectPid !== null) connectOptions.onSpawn?.(connection.connectPid);
      return connection;
    },
  });
  return { connections, configs, dispatches };
}

type Disconnected = Extract<McpServerEvent, { kind: "disconnected" }>;

/** The `disconnected` events without their `at`, which no assertion can pin. */
export function disconnectedEvents(events: readonly McpServerEvent[]): Omit<Disconnected, "at">[] {
  return events
    .filter((event): event is Disconnected => event.kind === "disconnected")
    .map(({ kind, serverId, workdir, reason, reconnect }) => ({ kind, serverId, workdir, reason, reconnect }));
}

/** The connection attempt `attempt` (1-based) handed back. */
export function connectionAt(harness: McpConnectHarness, attempt: number): FakeMcpConnection {
  const connection = harness.connections[attempt - 1];
  assertDefined(connection, `connection ${attempt}`);
  return connection;
}

/** The connection the pool is currently using for a workdir: the last one opened there. */
export function liveConnectionFor(harness: McpConnectHarness, workdir: string): FakeMcpConnection {
  const index = harness.configs.map((config) => config.cwd).lastIndexOf(workdir);
  const connection = harness.connections[index];
  assertDefined(connection, `connection for ${workdir}`);
  return connection;
}
