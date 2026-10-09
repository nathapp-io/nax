import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { client, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { createServerAuth } from "#src/server/auth";
import { initializeResponse } from "#src/server/capabilities";
import { buildAgentApp, serveStdio } from "#src/server/connection";
import { createSessionRegistry, type RegistryDeps } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { recordingLogger } from "#test/helpers/recording-logger";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-connection-");
});
afterEach(() => cleanupTempDir(dir));

function registryDeps(): RegistryDeps {
  const { logger } = recordingLogger();
  return {
    options: {
      configDir: "/cfg",
      sessionsDir: "/cfg/s",
      defaultModel: "anthropic/claude-sonnet-5-5",
      defaultMode: "ask",
      bashApproval: "gated",
      tiers: [],
      catalogOverrides: [],
      mcpConnectTimeoutSeconds: 30,
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
  };
}

function appDeps() {
  const deps = registryDeps();
  return { version: "9.9.9", registry: createSessionRegistry(deps), logger: deps.logger };
}

describe("initialize (S5-0/S5-3 capabilities)", () => {
  test("advertises load, list, resume, close and delete (S5-3, M-10)", () => {
    expect(initializeResponse("1.2.3")).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [],
      agentInfo: { name: "nax-agent", title: "nax-agent", version: "1.2.3" },
    });
  });

  test("advertises MCP over stdio and http, not sse", () => {
    expect(initializeResponse("1.0.0").agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: false });
  });

  test("an in-process client gets the response; session/fork is not served yet", async () => {
    const result = await client({ name: "test" }).connectWith(buildAgentApp(appDeps()), async (agent) => {
      const init = await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      const failure = await agent
        .request("session/fork", { sessionId: "s", cwd: "/tmp", mcpServers: [] })
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

describe("auth on the wire (S5-4)", () => {
  const methods = [
    { id: "login-anthropic", name: "Log in to anthropic", type: "terminal" as const, args: ["login", "anthropic"] },
  ];
  const auth = createServerAuth({ methods, overridden: new Set(), missing: async (ids) => [...ids] });

  test("terminal methods only for a client that declared auth.terminal", async () => {
    const result = await client({ name: "test" }).connectWith(buildAgentApp({ ...appDeps(), auth }), async (agent) => {
      const plain = await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      const terminal = await agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });
      return { plain, terminal };
    });
    expect(result.plain.authMethods).toEqual([]);
    expect(result.terminal.authMethods).toEqual(methods);
  });

  test("authenticate answers auth_required while the credential is missing", async () => {
    const failure = await client({ name: "test" }).connectWith(buildAgentApp({ ...appDeps(), auth }), async (agent) => {
      await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
      return agent.request("authenticate", { methodId: "login-anthropic" }).catch((e: unknown) => e);
    });
    expect(failure).toBeInstanceOf(RequestError);
    expect(failure instanceof RequestError ? failure.code : 0).toBe(-32000);
  });

  test("session/new fails auth_required when the open check refuses (M-30)", async () => {
    const deps = appDeps();
    const failure = await client({ name: "test" }).connectWith(
      buildAgentApp({
        ...deps,
        registry: createSessionRegistry({
          ...registryDeps(),
          ensureCredentials: (model) => auth.ensureCredentials(model),
        }),
        auth,
      }),
      async (agent) => {
        await agent.request("initialize", { protocolVersion: PROTOCOL_VERSION });
        return agent.request("session/new", { cwd: dir, mcpServers: [] }).catch((e: unknown) => e);
      },
    );
    expect(failure instanceof RequestError ? failure.code : 0).toBe(-32000);
  });
});
