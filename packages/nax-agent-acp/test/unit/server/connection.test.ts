import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { client, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { initializeResponse } from "#src/server/capabilities";
import { buildAgentApp, serveStdio } from "#src/server/connection";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { recordingLogger } from "#test/helpers/recording-logger";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-connection-");
});
afterEach(() => cleanupTempDir(dir));

function appDeps() {
  const { logger } = recordingLogger();
  const registry = createSessionRegistry({
    options: {
      configDir: "/cfg",
      sessionsDir: "/cfg/s",
      defaultMode: "ask",
      bashApproval: "gated",
      tiers: [],
      catalogOverrides: [],
    },
    openSession: async () => Promise.reject(new Error("unused")),
    storage: createSessionStorage({ dir, pid: 1000, now: () => new Date(), logger, isAlive: () => false }),
    transcripts: createMemoryTranscriptStore(),
    newId: () => "s1",
    now: () => new Date(),
    readOldText: async () => ({ kind: "missing" }),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    shutdownWaitMs: 50,
  });
  return { version: "9.9.9", registry, logger };
}

describe("initialize (S5-0/S5-2 capabilities)", () => {
  test("advertises only what is implemented (S5-2 adds no flags, M-10)", () => {
    expect(initializeResponse("1.2.3")).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [],
      agentInfo: { name: "nax-agent", title: "nax-agent", version: "1.2.3" },
    });
  });

  test("an in-process client gets the response; session/load is not served yet", async () => {
    const result = await client({ name: "test" }).connectWith(buildAgentApp(appDeps()), async (agent) => {
      const init = await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      const failure = await agent
        .request("session/load", { sessionId: "s", cwd: "/tmp", mcpServers: [] })
        .catch((e: unknown) => e);
      return { init, failure };
    });
    expect(result.init.agentInfo?.version).toBe("9.9.9");
    expect(result.failure).toBeInstanceOf(RequestError);
    expect(result.failure instanceof RequestError ? result.failure.code : 0).toBe(-32601);
  });
});

describe("serveStdio", () => {
  test("answers an initialize frame on stdout and closes when stdin ends", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const connection = serveStdio(buildAgentApp(appDeps()), { stdin, stdout });
    const line = new Promise<string>((resolve) =>
      stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
    );
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
    const frame = JSON.parse((await line).trim());
    expect(frame).toMatchObject({ jsonrpc: "2.0", id: 1, result: { agentInfo: { name: "nax-agent" } } });
    stdin.end();
    connection.close();
    await connection.closed;
  });
});
