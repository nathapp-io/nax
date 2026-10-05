import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  createMemoryTranscriptStore,
  isProcessAlive,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import type { FakeScript } from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { FAKE_MAIN, fakeEnv, readRecords, startOf } from "#test/helpers/fake-process";

const SECRET = "s3cr3t-token-value-0123";
let workdir: string;
let record: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-proc-");
  record = join(workdir, "record.jsonl");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  cleanupTempDir(workdir);
});

function backend(script: FakeScript, extra: Partial<AcpBackendOptions> = {}) {
  return acpBackend({
    agent: { name: "fake", command: process.execPath, args: [FAKE_MAIN] },
    allowUnsandboxed: true,
    env: { ...fakeEnv(script, record), FAKE_TOKEN: SECRET },
    ...extra,
  });
}

async function open(script: FakeScript, extra: Partial<AcpBackendOptions> = {}): Promise<AgentSession> {
  const session = await createAgentSession({
    backend: backend(script, extra),
    profile: "full",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
  });
  sessions.push(session);
  return session;
}

async function drain(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function endOf(events: readonly SessionEvent[]) {
  const last = events.at(-1);
  if (last?.type !== "turn_end") throw new Error("the turn did not end");
  return last;
}

const pidGone = (pid: number) => waitForCondition(() => !isProcessAlive(pid), 5_000);

describe("acpBackend over a real agent process (spec §9 subprocess fake)", () => {
  test("a text turn over pipes; the agent runs in workdir; close() ends the process", async () => {
    const session = await open({ turns: [{ steps: [{ kind: "text", text: "pong" }] }] });
    expect(endOf(await drain(session.send("ping")))).toMatchObject({ status: "completed", output: "pong" });
    const start = startOf(record);
    expect(realpathSync(start.cwd)).toBe(realpathSync(workdir));
    await session.close();
    await pidGone(start.pid);
  });

  test("the env allowlist holds end to end", async () => {
    process.env.NAX_ACP_TEST_LEAK = "1";
    try {
      await open({ recordEnv: ["NAX_ACP_TEST_LEAK", "FAKE_TOKEN"] });
      expect(startOf(record).env).toEqual({ NAX_ACP_TEST_LEAK: false, FAKE_TOKEN: true });
    } finally {
      delete process.env.NAX_ACP_TEST_LEAK;
    }
  });

  test("a line that is not JSON before the first answer is tolerated", async () => {
    const session = await open({ startup: { garbageLine: true } });
    expect(endOf(await drain(session.send("x"))).status).toBe("completed");
  });

  test("a crash mid-turn: BACKEND_UNAVAILABLE with redacted stderr; later turns AGENT_SESSION_CLOSED", async () => {
    const session = await open({
      turns: [
        {
          steps: [
            { kind: "text", text: "partial" },
            { kind: "exit", code: 7, stderr: `fatal ${SECRET}\n` },
          ],
        },
      ],
    });
    const crashed = endOf(await drain(session.send("x")));
    expect(crashed).toMatchObject({ status: "errored", error: { code: "AGENT_SESSION_BACKEND_UNAVAILABLE" } });
    expect(crashed.error?.message).toContain("exited with code 7");
    expect(crashed.error?.message).toContain("[REDACTED]");
    expect(crashed.error?.message).not.toContain(SECRET);
    expect(endOf(await drain(session.send("y")))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_CLOSED" },
    });
  });

  test("an ignored cancel: cancelled within the grace, the process killed, later turns CLOSED", async () => {
    const session = await open({ turns: [{ steps: [{ kind: "hang" }] }] }, { cancelGraceMs: 200 });
    const iterator = session.send("go")[Symbol.asyncIterator]();
    await iterator.next();
    await waitForCondition(() => readRecords(record).some((r) => r.method === "session/prompt"), 5_000);
    session.cancel();
    const rest: SessionEvent[] = [];
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) rest.push(next.value);
    expect(endOf(rest).status).toBe("cancelled");
    await pidGone(startOf(record).pid);
    expect(endOf(await drain(session.send("next"))).error?.code).toBe("AGENT_SESSION_CLOSED");
  });
});

describe("acpBackend: failed opens leave no process (Review Focus 1)", () => {
  async function failedOpen(script: FakeScript, extra: Partial<AcpBackendOptions> = {}) {
    return sessionError(
      await rejection(
        createAgentSession({
          backend: backend(script, extra),
          profile: "full",
          workdir,
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
  }

  test("exit during initialize: BACKEND_UNAVAILABLE with the exit code and redacted stderr", async () => {
    const err = await failedOpen({ startup: { stderr: `no credentials ${SECRET}\n`, exitCode: 2 } });
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.context).toMatchObject({ during: "initialize", exitCode: 2 });
    expect(String(err.context?.stderr)).toContain("no credentials [REDACTED]");
  });

  test("initialize timeout: BACKEND_UNAVAILABLE and the process is gone", async () => {
    const err = await failedOpen({ startup: { hang: true } }, { initializeTimeoutMs: 300 });
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    await pidGone(startOf(record).pid);
  });

  test("a model the agent does not offer: CAPABILITY_UNSUPPORTED and the process is gone", async () => {
    const err = await failedOpen({}, { model: "gpt-9" });
    expect(err.context).toMatchObject({ capability: "model" });
    await pidGone(startOf(record).pid);
  });

  test("a command that cannot be spawned: BACKEND_UNAVAILABLE", async () => {
    const err = sessionError(
      await rejection(
        createAgentSession({
          backend: acpBackend({
            agent: { name: "missing", command: join(workdir, "no-such-agent") },
            allowUnsandboxed: true,
          }),
          profile: "full",
          workdir,
          transcriptStore: createMemoryTranscriptStore(),
        }),
      ),
    );
    expect(err.code).toBe("AGENT_SESSION_BACKEND_UNAVAILABLE");
    expect(err.message).toContain("could not be started");
  });
});
