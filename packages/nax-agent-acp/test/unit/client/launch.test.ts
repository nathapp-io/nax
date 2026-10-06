import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import {
  agentGoneError,
  findExecutable,
  type LaunchedAgent,
  type LaunchRequest,
  launchAgent,
  pickCandidate,
} from "#src/client/launch";
import type { FakeScript } from "#test/fixtures/fake-agent/script";
import { childPidOf, FAKE_MAIN, fakeEnv, readRecords, startOf } from "#test/helpers/fake-process";

let dir: string;
const launched: LaunchedAgent[] = [];

beforeEach(() => {
  dir = makeTempDir("acp-launch-");
});

afterEach(() => {
  for (const agent of launched.splice(0)) agent.kill();
  cleanupTempDir(dir);
});

function fake(script: FakeScript, extra: Partial<LaunchRequest> = {}): { agent: LaunchedAgent; record: string } {
  const record = join(dir, "record.jsonl");
  const agent = launchAgent({
    command: process.execPath,
    args: [FAKE_MAIN],
    cwd: dir,
    env: fakeEnv(script, record),
    ...extra,
  });
  launched.push(agent);
  return { agent, record };
}

describe("findExecutable / pickCandidate (spec §6.10, D-i)", () => {
  test("bare names are looked up on the given PATH; files must be executable; absolute paths are checked as is", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "agent-x"), "#!/bin/sh\n");
    chmodSync(join(bin, "agent-x"), 0o755);
    writeFileSync(join(bin, "not-exec"), "");
    mkdirSync(join(bin, "a-dir"));
    expect(findExecutable("agent-x", bin)).toBe(true);
    expect(findExecutable("not-exec", bin)).toBe(false);
    expect(findExecutable("a-dir", bin)).toBe(false);
    expect(findExecutable("agent-x", undefined)).toBe(false);
    expect(findExecutable(join(bin, "agent-x"), undefined)).toBe(true);
    expect(findExecutable("./bin/agent-x", bin)).toBe(false);
    expect(
      pickCandidate(
        [
          { command: "missing-1", args: [] },
          { command: "agent-x", args: ["acp"] },
        ],
        bin,
      ),
    ).toEqual({ command: "agent-x", args: ["acp"] });
    expect(pickCandidate([{ command: "missing-1", args: [] }], bin)).toBeUndefined();
  });
});

describe("launchAgent (spec §6.1 launch)", () => {
  test("spawns a process-group leader in cwd with exactly the given env", async () => {
    process.env.NAX_ACP_LAUNCH_LEAK = "1";
    try {
      const { agent, record } = fake({
        startup: { hang: true },
        recordEnv: ["NAX_ACP_LAUNCH_LEAK", "FAKE_AGENT_SCRIPT"],
      });
      await waitForCondition(() => readRecords(record).length > 0, 5_000);
      const start = startOf(record);
      expect(agent.pid).toBe(start.pid);
      expect(() => process.kill(-start.pid, 0)).not.toThrow();
      expect(realpathSync(start.cwd)).toBe(realpathSync(dir));
      expect(start.env).toEqual({ NAX_ACP_LAUNCH_LEAK: false, FAKE_AGENT_SCRIPT: true });
    } finally {
      delete process.env.NAX_ACP_LAUNCH_LEAK;
    }
  });

  test("stderr feeds the tail; exited and whenGone report the exit code", async () => {
    const { agent } = fake({ startup: { stderr: "fatal: no credentials\n", exitCode: 3 } });
    expect(await agent.exited).toEqual({ code: 3, signal: null });
    expect(await agent.whenGone(1_000)).toEqual({ code: 3, signal: null });
    expect(agent.stderr.excerpt()).toContain("fatal: no credentials");
  });

  test("a command that cannot be spawned resolves exited with spawnError, never throws", async () => {
    const agent = launchAgent({ command: join(dir, "missing-agent"), args: [], cwd: dir, env: {} });
    const exit = await agent.exited;
    expect(exit.spawnError).toContain("ENOENT");
    expect(() => agent.kill()).not.toThrow();
    await agent.terminate(50);
  });

  test("a spawn that throws synchronously (NUL in an argument) also resolves exited with spawnError", async () => {
    const agent = launchAgent({ command: process.execPath, args: ["a\u0000b"], cwd: dir, env: {} });
    expect(agent.pid).toBeUndefined();
    expect((await agent.exited).spawnError).toBeDefined();
    expect(await agent.whenGone(10)).toMatchObject({ code: null, signal: null });
    await agent.terminate(10);
  });

  test("terminate: SIGTERM first", async () => {
    const { agent, record } = fake({ startup: { hang: true } });
    await waitForCondition(() => readRecords(record).length > 0, 5_000);
    await agent.terminate(2_000);
    expect((await agent.exited).signal).toBe("SIGTERM");
  });

  test("terminate: SIGKILL after the grace when SIGTERM is ignored", async () => {
    const { agent, record } = fake({ startup: { hang: true, ignoreSigterm: true } });
    await waitForCondition(() => readRecords(record).length > 0, 5_000);
    await agent.terminate(150);
    expect((await agent.exited).signal).toBe("SIGKILL");
  });

  test("kill reaches the whole process group", async () => {
    const { agent, record } = fake({ startup: { hang: true, spawnChild: true } });
    await waitForCondition(() => childPidOf(record) !== undefined, 5_000);
    const child = childPidOf(record) ?? -1;
    expect(isProcessAlive(child)).toBe(true);
    agent.kill();
    await agent.exited;
    await waitForCondition(() => !isProcessAlive(child), 5_000);
  });

  test("writing to a dead agent does not crash the host (EPIPE is handled)", async () => {
    const { agent } = fake({ startup: { exitCode: 0 } });
    await agent.exited;
    if (agent.target.kind !== "stream") throw new Error("expected a stream target");
    const writer = agent.target.stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", method: "ping" }).catch(() => undefined);
    await writer.write({ jsonrpc: "2.0", method: "ping" }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe("agentGoneError (spec §6.3, §7)", () => {
  test("BACKEND_UNAVAILABLE with the exit code and a redacted stderr excerpt", async () => {
    const secret = "s3cr3t-token-value-0123";
    const { agent } = fake({ startup: { stderr: `boom ${secret}\n`, exitCode: 2 } });
    await agent.exited;
    const err = await agentGoneError("initialize", agent, [secret]);
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("exited with code 2 during initialize");
    expect(err.message).not.toContain(secret);
    expect(err.context).toMatchObject({ during: "initialize", exitCode: 2, signal: null });
    expect(String(err.context?.stderr)).toContain("boom [REDACTED]");
  });
});
