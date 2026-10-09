import { afterEach, beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { connectMcp } from "@nathapp/nax-agent/mcp";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createMcpConnector } from "#src/server/mcp/connect";
import { OPTIONS, type RegistrySetupExtra, setupRegistry } from "#test/helpers/registry-setup";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-mcp-bridge-integration-");
});
afterEach(() => cleanupTempDir(dir));

const setup = (options = OPTIONS, extra: RegistrySetupExtra = {}) => setupRegistry(dir, options, extra);

const ECHO = fileURLToPath(new URL("../../../fixtures/mcp-echo-server.mjs", import.meta.url));

test("a real stdio server's tools reach the facade and run, with the env secret scrubbed", async () => {
  const s = setup(OPTIONS, {
    connectMcp: createMcpConnector({
      connect: connectMcp,
      timeoutMs: 15_000,
      clientVersion: "test",
      closeGraceMs: 500,
    }),
  });
  const { sessionId } = await s.registry.create(
    s.input(process.cwd(), [
      {
        name: "echo",
        command: process.execPath,
        args: [ECHO],
        env: [{ name: "API_TOKEN", value: "tok-secret-123456" }],
      },
    ]),
  );
  try {
    const tools = s.opened[0]?.tools ?? [];
    expect(tools.map((t) => `${t.name}:${t.approval}`)).toEqual(["echo__echo:always", "echo__secret:always"]);
    const ctx = { sessionId, toolCallId: "c1", signal: new AbortController().signal };
    expect(await tools[0]?.run({ text: "hello" }, ctx)).toEqual({ content: "hello", isError: false });
    const secret = await tools[1]?.run({}, ctx);
    expect(secret?.content).not.toContain("tok-secret-123456");
  } finally {
    await s.registry.close(sessionId);
  }
}, 30_000);
