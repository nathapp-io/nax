import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { setAgentLogger } from "@nathapp/nax-agent";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import type { AuthPorts } from "#src/server/auth";
import { type MainDeps, main } from "#src/server/main";
import { packageVersion } from "#src/server/version";

interface Harness {
  readonly deps: MainDeps;
  readonly stdin: PassThrough;
  readonly out: () => string;
  readonly err: () => string;
  readonly signal: () => void;
}

function fakeAuth(overrides: Partial<AuthPorts> = {}): AuthPorts {
  return {
    loginProviderIds: async () => ["anthropic"],
    providersWithoutCredentials: async () => [],
    runLogin: async (providerId, _interaction, method) => ({
      providerId,
      method: method ?? "api-key",
      kind: "api-key",
    }),
    interaction: () => ({ prompt: async () => "", notify: () => undefined }),
    ...overrides,
  };
}

function harness(argv: readonly string[], overrides: Partial<MainDeps> = {}): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const outChunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
  const errText: string[] = [];
  let signalHandler: () => void = () => {};
  const deps: MainDeps = {
    argv,
    env: {},
    homedir: "/home/u",
    isTTY: true,
    auth: fakeAuth(),
    stdin,
    stdout,
    writeErr: (text) => errText.push(text),
    readFile: async (path) => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    onSignal: (handler) => {
      signalHandler = handler;
    },
    ...overrides,
  };
  return {
    deps,
    stdin,
    out: () => Buffer.concat(outChunks).toString("utf8"),
    err: () => errText.join(""),
    signal: () => signalHandler(),
  };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => setAgentLogger(null));

describe("main", () => {
  test("--version prints the package version on stdout and exits 0", async () => {
    const h = harness(["--version"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toBe(`${packageVersion()}\n`);
  });

  test("--help prints usage and exits 0", async () => {
    const h = harness(["--help"]);
    expect(await main(h.deps)).toBe(0);
    expect(h.out()).toContain("Usage: nax-agent");
  });

  test("a usage error goes to stderr with usage and exits 2; stdout stays empty", async () => {
    const h = harness(["serve"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain("unknown command: serve");
    expect(h.err()).toContain("Usage: nax-agent");
    expect(h.out()).toBe("");
  });

  test("an invalid option exits 2 before serving", async () => {
    const h = harness(["--mode", "ask", "--bash-approval", "raw"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain('cannot be used with mode "ask"');
    expect(h.out()).toBe("");
  });

  test("an invalid --mcp-connect-timeout exits 2 before serving", async () => {
    const h = harness(["--mcp-connect-timeout", "0"]);
    expect(await main(h.deps)).toBe(2);
    expect(h.err()).toContain("invalid mcp connect timeout");
    expect(h.out()).toBe("");
  });

  test("serves initialize and exits 0 when stdin ends; logs only to stderr", async () => {
    const h = harness([]);
    const exit = main(h.deps);
    h.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`,
    );
    await tick(50);
    h.stdin.end();
    expect(await exit).toBe(0);
    const frames = h
      .out()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 1, result: { agentInfo: { name: "nax-agent" } } });
    expect(h.err()).toContain("nax-agent ACP server started");
  });

  test("advertises terminal login methods when the client declares auth.terminal (S5-4)", async () => {
    const config = { models: { native: { balanced: "anthropic/claude-sonnet-5-5" } } };
    const h = harness([], { readFile: async () => JSON.stringify(config) });
    const exit = main(h.deps);
    h.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } },
      })}\n`,
    );
    await waitForCondition(() => h.out().includes('"id":1'));
    h.stdin.end();
    expect(await exit).toBe(0);
    const frames = h
      .out()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames).toHaveLength(1);
    expect(frames[0].result.authMethods).toEqual([
      { id: "login-anthropic", name: "Log in to anthropic", type: "terminal", args: ["login", "anthropic"] },
    ]);
  });

  test("a signal stops the server with exit 0", async () => {
    const h = harness([]);
    const exit = main(h.deps);
    await tick(10);
    h.signal();
    expect(await exit).toBe(0);
  });

  test("a config warning is logged to stderr and the server still starts", async () => {
    const h = harness([], { readFile: async () => "{ nope" });
    const exit = main(h.deps);
    await tick(10);
    h.stdin.end();
    expect(await exit).toBe(0);
    expect(h.err()).toContain("invalid JSON");
  });

  test("NAX_AGENT_LOG=debug enables debug lines", async () => {
    const h = harness([], { env: { NAX_AGENT_LOG: "debug" } });
    const exit = main(h.deps);
    await tick(10);
    h.stdin.end();
    expect(await exit).toBe(0);
    expect(h.err()).toContain('"level":"debug"');
  });

  test("the debug log of resolved options never carries catalog override headers", async () => {
    const config = {
      agent: { native: { catalogOverrides: [{ provider: "p", headers: { Authorization: "Bearer sekret-123" } }] } },
    };
    const h = harness([], { env: { NAX_AGENT_LOG: "debug" }, readFile: async () => JSON.stringify(config) });
    const exit = main(h.deps);
    await tick(10);
    h.stdin.end();
    expect(await exit).toBe(0);
    expect(h.err()).toContain("resolved options");
    expect(h.err()).not.toContain("sekret-123");
  });
});

describe("main login (S5-4)", () => {
  test("login runs the login, prints the result on stdout and exits 0", async () => {
    const seen: string[] = [];
    const h = harness(["login", "anthropic"], {
      auth: fakeAuth({
        runLogin: async (providerId) => {
          seen.push(providerId);
          return { providerId, method: "oauth", kind: "oauth" };
        },
      }),
    });
    expect(await main(h.deps)).toBe(0);
    expect(seen).toEqual(["anthropic"]);
    expect(h.out()).toBe("Signed in to anthropic (method: oauth, credential: oauth)\n");
  });

  test("login without a TTY exits 1 and writes only to stderr", async () => {
    const h = harness(["login", "anthropic"], { isTTY: false });
    expect(await main(h.deps)).toBe(1);
    expect(h.out()).toBe("");
    expect(h.err()).toContain("needs an interactive terminal");
  });
});
