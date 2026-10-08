import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { setAgentLogger } from "@nathapp/nax-agent";
import { type MainDeps, main } from "#src/server/main";
import { packageVersion } from "#src/server/version";

interface Harness {
  readonly deps: MainDeps;
  readonly stdin: PassThrough;
  readonly out: () => string;
  readonly err: () => string;
  readonly signal: () => void;
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
});
