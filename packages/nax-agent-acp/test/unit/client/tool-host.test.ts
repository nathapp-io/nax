import { afterEach, describe, expect, test } from "bun:test";
import type { EmbedderTool, EmbedderToolContext, SessionAskPort } from "@nathapp/nax-agent";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import {
  createToolCalls,
  MAX_CONCURRENT_TOOL_CALLS,
  NO_TURN_TEXT,
  TOO_MANY_TEXT,
  type ToolCallDeps,
} from "#src/client/tool-calls";
import { createToolHost, MAX_BODY_BYTES, newToolHostToken, type ToolHost } from "#src/client/tool-host";
import { naxError, rejection } from "#test/helpers/errors";
import { rawRequest } from "#test/helpers/http";
import { mcpClient } from "#test/helpers/mcp-client";

const hosts: ToolHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const NO_ASK: SessionAskPort = {
  requestApproval: async () => ({ decision: "deny", decidedBy: "profile" }),
  recordAutoDecision: () => {},
  askQuestion: async () => null,
  noteQuestion: () => {},
};

const echo: EmbedderTool = {
  name: "echo",
  description: "Echo the input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  approval: "never",
  run: async (input) => ({ content: JSON.stringify(input) }),
};

interface Started {
  readonly host: ToolHost;
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Set to undefined to end the turn. */
  readonly turn: { id: string | undefined };
}

async function started(tools: readonly EmbedderTool[] = [echo]): Promise<Started> {
  const turn: { id: string | undefined } = { id: "turn-1" };
  const scope = new AbortController();
  const deps: ToolCallDeps = {
    sessionId: "s-1",
    tools,
    asks: NO_ASK,
    currentTurnId: () => turn.id,
    turnSignal: () => (turn.id === undefined ? undefined : scope.signal),
    secrets: [],
  };
  const host = createToolHost(createToolCalls(deps));
  hosts.push(host);
  const server = await host.start();
  return { host, url: server.url, port: Number(new URL(server.url).port), token: host.token, turn };
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const withToken = (token: string) => ({ ...MCP_HEADERS, authorization: `Bearer ${token}` });
const corsHeaders = (headers: Readonly<Record<string, unknown>>) =>
  Object.keys(headers).filter((name) => name.startsWith("access-control-"));

describe("start(): the session/new server entry (spec §6.6)", () => {
  test("127.0.0.1 on an ephemeral port, path /mcp, a 43-character base64url token", async () => {
    const s = await started();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(s.port).toBeGreaterThan(0);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the entry carries the token as an Authorization header", async () => {
    const host = createToolHost(createToolCalls({ ...baseDeps(), tools: [echo] }));
    hosts.push(host);
    expect(await host.start()).toEqual({
      type: "http",
      name: "nax",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      headers: [{ name: "Authorization", value: `Bearer ${host.token}` }],
    });
  });

  test("each host gets its own 32-byte token", () => {
    const a = newToolHostToken();
    const b = newToolHostToken();
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

function baseDeps(): ToolCallDeps {
  const scope = new AbortController();
  return {
    sessionId: "s-1",
    tools: [],
    asks: NO_ASK,
    currentTurnId: () => "turn-1",
    turnSignal: () => scope.signal,
    secrets: [],
  };
}

describe("MCP over the host", () => {
  test("tools/list is exactly the session's tools; tools/call round-trips", async () => {
    const s = await started();
    const client = await mcpClient(s.url, s.token);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["echo"]);
      // #2365: the hint survives the MCP server, so Claude's plan mode sees it.
      expect(listed.tools[0]?.annotations).toEqual({ readOnlyHint: true });
      expect(await client.callTool({ name: "echo", arguments: { text: "hi" } })).toMatchObject({
        content: [{ type: "text", text: '{"text":"hi"}' }],
      });
    } finally {
      await client.close();
    }
  });

  test("a call after the turn ended: the no-turn tool error", async () => {
    const s = await started();
    s.turn.id = undefined;
    const client = await mcpClient(s.url, s.token);
    try {
      expect(await client.callTool({ name: "echo", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: NO_TURN_TEXT }],
        isError: true,
      });
    } finally {
      await client.close();
    }
  });

  test(`the ${MAX_CONCURRENT_TOOL_CALLS + 1}th concurrent call is refused and does not run`, async () => {
    let begun = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking: EmbedderTool = {
      ...echo,
      name: "block",
      run: async () => {
        begun += 1;
        await gate;
        return { content: "done" };
      },
    };
    const s = await started([blocking]);
    const client = await mcpClient(s.url, s.token);
    try {
      const first = Array.from({ length: MAX_CONCURRENT_TOOL_CALLS }, () =>
        client.callTool({ name: "block", arguments: {} }),
      );
      await waitForCondition(() => begun === MAX_CONCURRENT_TOOL_CALLS, 3_000);
      expect(await client.callTool({ name: "block", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: TOO_MANY_TEXT }],
        isError: true,
      });
      expect(begun).toBe(MAX_CONCURRENT_TOOL_CALLS);
      release();
      await Promise.all(first);
    } finally {
      await client.close();
    }
  });
});

describe("the gate (spec §6.6 request checks; Review Focus 2)", () => {
  test("a raw tools/list with the token passes the gate (200) and carries no CORS header", async () => {
    const s = await started();
    const res = await rawRequest({ port: s.port, headers: withToken(s.token), body: [LIST] });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"echo"');
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  test.each([
    ["no Authorization header", {}],
    ["a wrong token", { authorization: "Bearer not-the-token" }],
    ["another scheme", { authorization: "Basic abc" }],
    ["an empty bearer", { authorization: "Bearer " }],
  ])("%s: 401, no CORS header", async (_label, extra) => {
    const s = await started();
    const res = await rawRequest({ port: s.port, headers: { ...MCP_HEADERS, ...extra }, body: [LIST] });
    expect(res.status).toBe(401);
    expect(corsHeaders(res.headers)).toEqual([]);
  });

  test("another host's token: 401", async () => {
    const a = await started();
    const b = await started();
    expect((await rawRequest({ port: a.port, headers: withToken(b.token), body: [LIST] })).status).toBe(401);
  });

  test.each([
    ["localhost:<port>", (port: number) => `localhost:${port}`],
    ["127.0.0.1 without a port", () => "127.0.0.1"],
    ["127.0.0.1 on another port", (port: number) => `127.0.0.1:${port + 1}`],
    ["an attacker's name", (port: number) => `evil.example:${port}`],
  ])("Host %s (DNS rebinding): 403 even with the token", async (_label, hostFor) => {
    const s = await started();
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), host: hostFor(s.port) },
      body: [LIST],
    });
    expect(res.status).toBe(403);
  });

  test.each([
    ["no token", 401, (_s: Started) => ({ ...MCP_HEADERS })],
    ["a wrong Host", 403, (s: Started) => ({ ...withToken(s.token), host: `localhost:${s.port}` })],
    ["an Origin", 403, (s: Started) => ({ ...withToken(s.token), origin: "http://evil.example" })],
  ])("%s, headers only: refused without reading any body", async (_label, status, headersFor) => {
    const s = await started();
    // The request declares a body but never sends it: the refusal must not wait for one.
    const res = await rawRequest({ port: s.port, headers: { ...headersFor(s), "content-length": "100" } });
    expect(res.status).toBe(status);
  });

  test("any Origin header: 403 even with the token", async () => {
    const s = await started();
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), origin: `http://127.0.0.1:${s.port}` },
      body: [LIST],
    });
    expect(res.status).toBe(403);
  });

  test("another path: 404; GET: 405 with Allow: POST", async () => {
    const s = await started();
    expect((await rawRequest({ port: s.port, path: "/other", headers: withToken(s.token), body: [LIST] })).status).toBe(
      404,
    );
    const get = await rawRequest({ port: s.port, method: "GET", headers: withToken(s.token), body: [] });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
  });

  test("a query string does not change the path check", async () => {
    const s = await started();
    expect(
      (await rawRequest({ port: s.port, path: "/mcp?x=1", headers: withToken(s.token), body: [LIST] })).status,
    ).toBe(200);
  });

  test("a declared content-length over 1 MiB: 413 before any body is read", async () => {
    const s = await started();
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), "content-length": String(MAX_BODY_BYTES + 1) },
    });
    expect(res.status).toBe(413);
  });

  test("a streamed body over 1 MiB: 413", async () => {
    const s = await started();
    const half = Buffer.alloc(MAX_BODY_BYTES / 2 + 1, 0x20);
    const res = await rawRequest({
      port: s.port,
      headers: { ...withToken(s.token), "transfer-encoding": "chunked" },
      body: [half, half],
    });
    expect(res.status).toBe(413);
  });

  test("a body just under 1 MiB reaches MCP", async () => {
    const s = await started();
    const prefix = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_pad":"';
    const suffix = '"}}';
    const pad = "x".repeat(MAX_BODY_BYTES - prefix.length - suffix.length - 16);
    const res = await rawRequest({ port: s.port, headers: withToken(s.token), body: [prefix, pad, suffix] });
    expect(res.status).toBe(200);
  });

  test("invalid JSON: 400", async () => {
    const s = await started();
    expect((await rawRequest({ port: s.port, headers: withToken(s.token), body: ["{not json"] })).status).toBe(400);
  });
});

describe("drain and stop (spec §6.6 close; Review Focus 1, 3)", () => {
  test("stop(): the port refuses connections; stop() is idempotent; stop() before start() resolves", async () => {
    const s = await started();
    await s.host.stop();
    await s.host.stop();
    await expect(rawRequest({ port: s.port, headers: withToken(s.token), body: [LIST] })).rejects.toThrow();
    await createToolHost(createToolCalls(baseDeps())).stop();
  });

  test("start() after stop() refuses: a stopped host never listens again", async () => {
    const host = createToolHost(createToolCalls(baseDeps()));
    await host.stop();
    const err = naxError(await rejection(host.start()));
    expect(err.code).toBe("ACP_TOOL_HOST_STOPPED");
  });

  test("stop() during a call: the call's signal aborts (the connection is dropped)", async () => {
    const seen: EmbedderToolContext[] = [];
    const hang: EmbedderTool = {
      ...echo,
      name: "hang",
      run: (_input, ctx) => {
        seen.push(ctx);
        return new Promise(() => {});
      },
    };
    const s = await started([hang]);
    const client = await mcpClient(s.url, s.token);
    void client.callTool({ name: "hang", arguments: {} }).catch(() => undefined);
    await waitForCondition(() => seen.length === 1, 3_000);
    await s.host.stop();
    await waitForCondition(() => seen[0]?.signal.aborted === true, 3_000);
    await s.host.drain();
    await client.close().catch(() => undefined);
  });
});
