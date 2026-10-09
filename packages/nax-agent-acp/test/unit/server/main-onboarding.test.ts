import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { setAgentLogger } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import type { AuthPorts } from "#src/server/auth";
import { type MainDeps, main } from "#src/server/main";

const CONFIG_PATH = "/home/u/.nax/config.json";
const MODEL = "anthropic/claude-sonnet-5";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-main-onboarding-");
});
afterEach(() => {
  setAgentLogger(null);
  cleanupTempDir(dir);
});

function fakeAuth(): AuthPorts {
  return {
    loginProviderIds: async () => ["anthropic", "openai"],
    providersWithoutCredentials: async () => [],
    runLogin: async (providerId) => ({ providerId, method: "api-key", kind: "api-key" }),
    interaction: () => ({ prompt: async () => `model:${MODEL.split("/")[1]}`, notify: () => undefined }),
  };
}

/** An in-memory config.json shared by the server and the login command. */
function memoryConfig() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (path: string): Promise<string> => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return text;
    },
    writeConfig: async (path: string, text: string): Promise<void> => {
      files.set(path, text);
    },
  };
}

function harness(argv: readonly string[], config: ReturnType<typeof memoryConfig>, env: MainDeps["env"] = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const errText: string[] = [];
  const deps: MainDeps = {
    argv,
    env: { NAX_AGENT_SESSIONS_DIR: dir, ...env },
    homedir: "/home/u",
    isTTY: true,
    auth: fakeAuth(),
    models: { listModels: async () => [{ id: MODEL.split("/")[1] ?? "", contextWindow: 200_000 }] },
    writeConfig: config.writeConfig,
    readFile: config.readFile,
    stdin,
    stdout,
    writeErr: (text) => errText.push(text),
    onSignal: () => undefined,
  };
  const frames = () =>
    Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  const send = (id: number, method: string, params: unknown) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const reply = async (id: number) => {
    await waitForCondition(() => frames().some((f) => f.id === id));
    return frames().find((f) => f.id === id);
  };
  return { deps, stdin, send, reply, out: () => Buffer.concat(chunks).toString("utf8"), err: () => errText.join("") };
}

describe("login-first onboarding over the stdio server", () => {
  test("with no model: terminal login for every provider, and session/new is auth_required", async () => {
    const config = memoryConfig();
    const h = harness([], config);
    const exit = main(h.deps);
    h.send(1, "initialize", { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } });
    const init = await h.reply(1);
    expect(init.result.authMethods.map((m: { id: string }) => m.id)).toEqual(["login-anthropic", "login-openai"]);
    h.send(2, "session/new", { cwd: dir, mcpServers: [] });
    const created = await h.reply(2);
    expect(created.error.code).toBe(-32000);
    expect(created.error.message).toContain("no model configured");
    expect(created.error.message).toContain("nax-agent login");
    h.stdin.end();
    expect(await exit).toBe(0);
  });

  test("login writes the default model; the running server's next session/new then works", async () => {
    const config = memoryConfig();
    // read mode: opening the session needs no OS sandbox (CI runners lack bwrap/socat/rg).
    const server = harness(["--mode", "read"], config);
    const serving = main(server.deps);
    server.send(1, "initialize", { protocolVersion: 1 });
    await server.reply(1);
    server.send(2, "session/new", { cwd: dir, mcpServers: [] });
    expect((await server.reply(2)).error.code).toBe(-32000);

    const login = harness(["login", "anthropic"], config);
    expect(await main(login.deps)).toBe(0);
    expect(JSON.parse(config.files.get(CONFIG_PATH) ?? "")).toEqual({ models: { native: { balanced: MODEL } } });
    expect(login.out()).toContain(`Set models.native.balanced to ${MODEL}`);

    server.send(3, "session/new", { cwd: dir, mcpServers: [] });
    const retried = await server.reply(3);
    expect(retried.error).toBeUndefined();
    expect(retried.result.configOptions.find((o: { id: string }) => o.id === "model").currentValue).toBe(MODEL);
    server.stdin.end();
    expect(await serving).toBe(0);
  });

  test("an explicit NAX_AGENT_MODEL wins over the config file", async () => {
    const config = memoryConfig();
    config.files.set(CONFIG_PATH, JSON.stringify({ models: { native: { balanced: "openai/gpt-x" } } }));
    const h = harness(["--mode", "read"], config, { NAX_AGENT_MODEL: MODEL });
    const exit = main(h.deps);
    h.send(1, "initialize", { protocolVersion: 1 });
    await h.reply(1);
    h.send(2, "session/new", { cwd: dir, mcpServers: [] });
    const created = await h.reply(2);
    expect(created.result.configOptions.find((o: { id: string }) => o.id === "model").currentValue).toBe(MODEL);
    h.stdin.end();
    expect(await exit).toBe(0);
  });

  test("a config problem is logged and named in the auth_required message", async () => {
    const config = memoryConfig();
    config.files.set(CONFIG_PATH, "{ not json");
    const h = harness([], config);
    const exit = main(h.deps);
    h.send(1, "initialize", { protocolVersion: 1 });
    await h.reply(1);
    h.send(2, "session/new", { cwd: dir, mcpServers: [] });
    const created = await h.reply(2);
    expect(created.error.code).toBe(-32000);
    expect(created.error.message).toContain("config.json could not be used: ignoring");
    expect(created.error.message).toContain("invalid JSON");
    h.stdin.end();
    expect(await exit).toBe(0);
    // once at startup, once for the reload
    expect(h.err().split("invalid JSON").length - 1).toBe(2);
    expect(h.err()).not.toContain("not json");
  });

  test("login does not offer a model when NAX_AGENT_MODEL is set", async () => {
    const config = memoryConfig();
    const login = harness(["login", "anthropic"], config, { NAX_AGENT_MODEL: MODEL });
    expect(await main(login.deps)).toBe(0);
    expect(config.files.size).toBe(0);
  });
});
