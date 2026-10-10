import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "#src/internal/process-alive";
import { connectMcp } from "#src/mcp/connect";
import { McpConnectError } from "#src/mcp/errors";
import type { McpConnection, McpTransportConfig } from "#src/mcp/types";
import { assertCaughtInstanceOf } from "#test/helpers/index";

const SERVER = fileURLToPath(new URL("../../fixtures/mcp/stdio-server.mjs", import.meta.url));
const OPTS = { signal: new AbortController().signal, timeoutMs: 10_000, clientInfo: { name: "t", version: "0" } };
const CALL = { signal: new AbortController().signal, timeoutMs: 5000, maxBytes: 10_000 };

const stdio = (args: string[] = [], env: Record<string, string> = {}): McpTransportConfig => ({
  kind: "stdio",
  command: process.execPath,
  args: [SERVER, ...args],
  env,
  cwd: process.cwd(),
});

async function pidOf(connection: McpConnection): Promise<number> {
  return Number((await connection.call("pid", {}, CALL)).text);
}

function killQuietly(pid: number): void {
  if (pid <= 0) return; // never signal a process group / an unknown pid
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("connectMcp over stdio", () => {
  test("env is an overlay: PATH survives and configured vars arrive", async () => {
    const connection = await connectMcp(stdio([], { FIXTURE_VAR: "x1" }), OPTS);
    let pid = -1;
    try {
      pid = await pidOf(connection);
      expect((await connection.call("env", { name: "FIXTURE_VAR" }, CALL)).text).toBe("x1");
      expect((await connection.call("env", { name: "PATH" }, CALL)).text).not.toBe("<unset>");
    } finally {
      await connection.close().catch(() => undefined);
      killQuietly(pid);
    }
  }, 20_000);

  test("exposes the stdio child pid on the connection", async () => {
    const connection = await connectMcp(stdio(), OPTS);
    const pid = await pidOf(connection);
    try {
      expect(connection.pid).toBe(pid);
    } finally {
      await connection.close().catch(() => undefined);
      killQuietly(pid);
    }
  }, 20_000);

  test("close() resolves only after the process is gone", async () => {
    const connection = await connectMcp(stdio(), OPTS);
    const pid = await pidOf(connection);
    try {
      await connection.close();
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      killQuietly(pid);
    }
  }, 20_000);

  test("a stubborn server is SIGKILLed within closeGraceMs", async () => {
    const connection = await connectMcp(stdio(["--stubborn"]), { ...OPTS, closeGraceMs: 300 });
    const pid = await pidOf(connection);
    try {
      const started = Date.now();
      await connection.close();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      killQuietly(pid);
    }
  }, 20_000);

  test("onClose fires once when the process exits unexpectedly, never on close()", async () => {
    const reasons: string[] = [];
    const connection = await connectMcp(stdio(), OPTS);
    let pid = -1;
    let other: McpConnection | undefined;
    let otherPid = -1;
    try {
      pid = await pidOf(connection);
      connection.onClose((reason) => reasons.push(reason));
      await connection.call("crash", {}, CALL).catch(() => undefined);
      for (let i = 0; i < 40 && reasons.length === 0; i += 1) await settle(25);
      expect(reasons).toEqual(["the server process exited"]);
      await connection.close();
      expect(reasons).toHaveLength(1);

      other = await connectMcp(stdio(), OPTS);
      otherPid = await pidOf(other);
      const seen: string[] = [];
      other.onClose((reason) => seen.push(reason));
      await other.close();
      expect(seen).toEqual([]);
    } finally {
      await connection.close().catch(() => undefined);
      await other?.close().catch(() => undefined);
      killQuietly(pid);
      killQuietly(otherPid);
    }
  }, 20_000);

  test("an exit before onClose is attached is reported to the late listener", async () => {
    const connection = await connectMcp(stdio(), OPTS);
    let pid = -1;
    try {
      pid = await pidOf(connection);
      await connection.call("crash", {}, CALL).catch(() => undefined);
      await settle(300);
      const reasons: string[] = [];
      connection.onClose((reason) => reasons.push(reason));
      expect(reasons).toEqual(["the server process exited"]);
      await connection.close();
    } finally {
      await connection.close().catch(() => undefined);
      killQuietly(pid);
    }
  }, 20_000);

  test("a server that exits at start fails with its stderr tail", async () => {
    const error = await connectMcp(stdio(["--stderr", "boom: missing config", "--exit-at-start"]), OPTS).catch(
      (e: unknown) => e,
    );
    assertCaughtInstanceOf(error, McpConnectError);
    expect(error.stderrTail).toContain("boom: missing config");
  }, 20_000);

  test("a command that does not exist fails with McpConnectError", async () => {
    const config: McpTransportConfig = { kind: "stdio", command: "/nonexistent/mcp-bin", args: [], env: {}, cwd: "/" };
    await expect(connectMcp(config, OPTS)).rejects.toBeInstanceOf(McpConnectError);
  }, 20_000);
});
