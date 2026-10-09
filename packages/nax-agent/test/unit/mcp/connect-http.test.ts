import { afterEach, describe, expect, test } from "bun:test";
import { connectMcp } from "#src/mcp/connect";
import { McpConnectError } from "#src/mcp/errors";
import { type HttpFixture, httpServer } from "#test/helpers/mcp-servers";

const OPTS = { signal: new AbortController().signal, timeoutMs: 5000, clientInfo: { name: "t", version: "0" } };
const CALL = { signal: new AbortController().signal, timeoutMs: 5000, maxBytes: 10_000 };

let fixture: HttpFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("connectMcp over streamable HTTP", () => {
  test("sends the configured headers on every request and calls a tool", async () => {
    fixture = await httpServer();
    const connection = await connectMcp(
      { kind: "http", url: fixture.url, headers: { Authorization: "Bearer tok-123456789", "X-Team": "a" } },
      OPTS,
    );
    expect(connection.kind).toBe("http");
    expect(connection.tools.map((t) => t.name)).toEqual(["echo"]);
    expect((await connection.call("echo", { a: 1 }, CALL)).text).toBe('{"a":1}');
    expect(fixture.headers.length).toBeGreaterThanOrEqual(2);
    for (const h of fixture.headers) {
      expect(h.authorization).toBe("Bearer tok-123456789");
      expect(h["x-team"]).toBe("a");
    }
    await connection.close();
  });

  test("close() terminates the MCP session (DELETE)", async () => {
    fixture = await httpServer();
    const connection = await connectMcp({ kind: "http", url: fixture.url, headers: {} }, OPTS);
    await connection.close();
    expect(fixture.deletes()).toBe(1);
  });

  test("a server that is down fails connect with McpConnectError within the timeout", async () => {
    const started = Date.now();
    const error = await connectMcp(
      { kind: "http", url: "http://127.0.0.1:9/mcp", headers: {} },
      { ...OPTS, timeoutMs: 1000 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpConnectError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("an HTTP connection never reports onClose", async () => {
    fixture = await httpServer();
    const connection = await connectMcp({ kind: "http", url: fixture.url, headers: {} }, OPTS);
    const reasons: string[] = [];
    connection.onClose((r) => reasons.push(r));
    await fixture.close();
    fixture = undefined;
    await new Promise((r) => setTimeout(r, 100));
    expect(reasons).toEqual([]);
    await connection.close();
  });
});
