/**
 * The MCP tool host (S4 spec §6.6): an HTTP server on 127.0.0.1, an ephemeral
 * port, path /mcp, serving the session's embedder tools to the agent. Before a
 * request reaches MCP it passes the gate (D4-e): path, method, Host (DNS
 * rebinding), Origin, the bearer token (constant time) and the 1 MiB body cap.
 * Each POST then gets a fresh stateless MCP server and transport (D4-d): the SDK
 * refuses to reuse a stateless transport. The token exists before the host
 * listens, so it joins the session's redaction set from the start (D4-i). stop()
 * revokes the token, aborts calls, drops open connections and closes the port
 * (D4-l).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@agentclientprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NaxError } from "@nathapp/nax-agent";
import { TOOL_HOST_SERVER_NAME } from "#src/client/pre-approval";
import { race } from "#src/client/race";
import type { ToolCalls } from "#src/client/tool-calls";

export type HttpMcpServer = Extract<McpServer, { type: "http" }>;

export const TOOL_HOST_PATH = "/mcp";
export const MAX_BODY_BYTES = 1024 * 1024;
/** Past this many body bytes the 413 is sent at once and the connection closed. */
export const MAX_DRAIN_BYTES = 8 * MAX_BODY_BYTES;
/** stop() waits at most this long for the port to close. */
const CLOSE_WAIT_MS = 2_000;
const LOOPBACK = "127.0.0.1";
const BEARER = "Bearer ";
/** MCP-level server identity shown to the agent; not the package version. */
const SERVER_INFO = { name: TOOL_HOST_SERVER_NAME, version: "1.0.0" };

export interface ToolHost {
  /** Known before start(), so every redaction set can include it. */
  readonly token: string;
  /** Listens on 127.0.0.1, an ephemeral port; returns the session/new server entry. */
  start(): Promise<HttpMcpServer>;
  /** Resolves once every call in flight has answered. */
  drain(): Promise<void>;
  /**
   * Revokes the token, aborts every call in flight, drops open connections and
   * closes the port (bounded wait). Idempotent; safe before start(); start()
   * after it refuses.
   */
  stop(): Promise<void>;
}

interface HostState {
  readonly token: string;
  readonly calls: ToolCalls;
  /** Aborted by stop(): every call's signal includes it, so calls answer even where a dropped socket fires nothing. */
  readonly stopped: AbortController;
  port: number;
}

interface Refusal {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

type Body =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

export function newToolHostToken(): string {
  return randomBytes(32).toString("base64url");
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Constant time: both sides are hashed to the same length first. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith(BEARER) === true ? header.slice(BEARER.length) : "";
  return timingSafeEqual(digest(presented), digest(token));
}

function pathOf(url: string | undefined): string {
  return (url ?? "").split("?")[0] ?? "";
}

/** Everything checked before the body is read, in order (D4-e). */
function refusalFor(state: HostState, req: IncomingMessage): Refusal | undefined {
  if (pathOf(req.url) !== TOOL_HOST_PATH) return { status: 404 };
  if (req.method !== "POST") return { status: 405, headers: { allow: "POST" } };
  if (req.headers.host !== `${LOOPBACK}:${state.port}` || req.headers.origin !== undefined) return { status: 403 };
  if (state.stopped.signal.aborted || !tokenMatches(req.headers.authorization, state.token)) return { status: 401 };
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return { status: 413, headers: { connection: "close" } };
  }
  return undefined;
}

function reply(res: ServerResponse, refusal: Refusal): void {
  res.writeHead(refusal.status, { "content-type": "text/plain; charset=utf-8", ...refusal.headers });
  res.end(`${refusal.status}\n`);
}

function parseJson(bytes: Buffer): Body {
  try {
    return { kind: "json", value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * At most MAX_BODY_BYTES kept; past that the rest is drained and discarded, so the
 * 413 is still delivered. Past MAX_DRAIN_BYTES the 413 is sent at once and the
 * connection is closed after it: an endless body cannot hold the socket.
 */
function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else if (size > MAX_DRAIN_BYTES) resolve({ kind: "too-large" });
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? { kind: "too-large" } : parseJson(Buffer.concat(chunks))));
    req.on("error", () => resolve({ kind: "invalid" }));
    req.on("close", () => resolve({ kind: "invalid" }));
  });
}

/** One stateless MCP server per request (D4-d). Its calls abort when the response closes or the host stops. */
async function serveMcp(state: HostState, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const gone = new AbortController();
  const signal = AbortSignal.any([gone.signal, state.stopped.signal]);
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.calls.list() }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    state.calls.call(request.params.name, request.params.arguments, signal),
  );
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on("close", () => {
    gone.abort();
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function handle(state: HostState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refusal = refusalFor(state, req);
  if (refusal !== undefined) return reply(res, refusal);
  const body = await readBody(req);
  if (body.kind === "too-large") {
    res.once("finish", () => req.destroy());
    return reply(res, { status: 413, headers: { connection: "close" } });
  }
  if (body.kind === "invalid") return reply(res, { status: 400 });
  await serveMcp(state, req, res, body.value);
}

function failed(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  reply(res, { status: 500 });
}

function listen(http: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, LOOPBACK, () => {
      http.off("error", reject);
      const address = http.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

/**
 * closeAllConnections() first, then close(): on Bun 1.4 the reverse order never
 * fires the close callback while a request is in flight (probed while planning;
 * Node works either way). The wait is bounded all the same, so close() can never
 * hang on a runtime quirk.
 */
async function close(http: HttpServer): Promise<void> {
  if (!http.listening) return;
  const closed = new Promise<void>((resolve) => {
    http.closeAllConnections();
    http.close(() => resolve());
  });
  await race(closed, { timeoutMs: CLOSE_WAIT_MS });
}

export function createToolHost(calls: ToolCalls, token: string = newToolHostToken()): ToolHost {
  const state: HostState = { token, calls, stopped: new AbortController(), port: 0 };
  const http = createServer((req, res) => {
    void handle(state, req, res).catch(() => failed(res));
  });
  let stopping: Promise<void> | undefined;
  return {
    token,
    async start() {
      if (state.stopped.signal.aborted) {
        throw new NaxError("The MCP tool host was already stopped", "ACP_TOOL_HOST_STOPPED", { stage: "acp" });
      }
      state.port = await listen(http);
      return {
        type: "http",
        name: TOOL_HOST_SERVER_NAME,
        url: `http://${LOOPBACK}:${state.port}${TOOL_HOST_PATH}`,
        headers: [{ name: "Authorization", value: `${BEARER}${token}` }],
      };
    },
    drain: () => calls.drain(),
    stop() {
      state.stopped.abort();
      stopping ??= close(http);
      return stopping;
    },
  };
}
