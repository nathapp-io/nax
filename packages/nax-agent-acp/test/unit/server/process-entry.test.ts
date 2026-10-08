import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { setAgentLogger } from "@nathapp/nax-agent";
import { mainDepsFrom, type ProcessLike, runCli } from "#src/server/process-entry";
import { packageVersion } from "#src/server/version";

function fakeProcess(argv: readonly string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners: Array<{ event: string; listener: () => void }> = [];
  const proc: ProcessLike = {
    argv: ["node", "nax-agent", ...argv],
    env: { NAX_AGENT_CONFIG_DIR: "/nonexistent-nax-agent-config" },
    stdin: new PassThrough(),
    stdout,
    stderr,
    once: (event, listener) => {
      listeners.push({ event, listener });
      return proc;
    },
  };
  const read = (stream: PassThrough) => () => String(stream.read() ?? "");
  return { proc, listeners, out: read(stdout), err: read(stderr) };
}

afterEach(() => setAgentLogger(null));

describe("mainDepsFrom", () => {
  test("drops node and script from argv and wires both signals to one handler", () => {
    const { proc, listeners } = fakeProcess(["--version"]);
    const deps = mainDepsFrom(proc);
    expect(deps.argv).toEqual(["--version"]);
    const handler = () => {};
    deps.onSignal(handler);
    expect(listeners.map((l) => l.event)).toEqual(["SIGINT", "SIGTERM"]);
    expect(listeners.every((l) => l.listener === handler)).toBe(true);
  });

  test("writeErr goes to stderr; readFile reads real files", async () => {
    const { proc, err } = fakeProcess([]);
    const deps = mainDepsFrom(proc);
    deps.writeErr("oops\n");
    expect(err()).toBe("oops\n");
    expect(await deps.readFile(new URL("../../../package.json", import.meta.url).pathname, "utf8")).toContain(
      "@nathapp/nax-agent-acp",
    );
  });
});

describe("runCli", () => {
  test("runs main against the process", async () => {
    const { proc, out } = fakeProcess(["--version"]);
    expect(await runCli(proc)).toBe(0);
    expect(out()).toBe(`${packageVersion()}\n`);
  });
});
