import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep } from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
let workdir: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-reconnect-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

const RESUMABLE: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
  capabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true } },
};

const text = (t: string): FakeStep => ({ kind: "text", text: t });
const usd = (amount: number): FakeStep => ({
  kind: "update",
  update: { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount, currency: "USD" } },
});
/** Lets the backend observe the in-memory process exit. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function open(
  script: FakeScript,
  tools: EmbedderTool[] = [],
): Promise<{ fake: InMemoryAgent; session: AgentSession }> {
  const fake = inMemoryAgent({ ...RESUMABLE, ...script });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({
      agent: "claude",
      allowUnsandboxed: true,
      command: "fake-claude",
      initializeTimeoutMs: 30_000,
    }),
    profile: "full",
    workdir,
    tools,
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

/** Starts a turn and returns its iterator once `ready` holds. */
async function startTurn(session: AgentSession, ready: () => boolean): Promise<AsyncIterator<SessionEvent>> {
  const iterator = session.send("go")[Symbol.asyncIterator]();
  void iterator.next();
  await waitForCondition(ready, 2_000);
  return iterator;
}

async function rest(iterator: AsyncIterator<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) out.push(next.value);
  return out;
}

describe("reconnect after a crash (spec §6.3 step 5, S4-6 D6-g)", () => {
  test("a crash between turns: the next turn reconnects with session/resume in a new process", async () => {
    const { fake, session } = await open({ relaunch: { turns: [{ steps: [text("back")] }] } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two"))).toMatchObject({ status: "completed", output: "back" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.callsTo("session/resume")).toEqual([{ sessionId: "fake-session-1", cwd: workdir, mcpServers: [] }]);
    expect(session.backend.capabilities).toMatchObject({ restoredWith: "resume" });
  });

  test("a crash mid-turn errors that turn; the next one reconnects", async () => {
    const { fake, session } = await open({
      turns: [{ steps: [{ kind: "hang" }] }],
      relaunch: { turns: [{ steps: [text("back")] }] },
    });
    const iterator = await startTurn(session, () => fake.callsTo("session/prompt").length === 1);
    fake.crash();
    expect(endOf(await rest(iterator))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_BACKEND_UNAVAILABLE" },
    });
    expect(endOf(await driveTurn(session, "two")).output).toBe("back");
  });

  test("the cost baseline carries over: 0.01 then 0.03 after a reconnect is 0.02 (Review Focus 3)", async () => {
    const { fake, session } = await open({
      turns: [{ steps: [usd(0.01), text("a")] }],
      relaunch: { turns: [{ steps: [usd(0.03), text("b")] }] },
    });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two")).costUsd).toBeCloseTo(0.02, 10);
  });

  test("an agent without resume or load: AGENT_SESSION_CLOSED, nothing spawned", async () => {
    const { fake, session } = await open({ capabilities: {} });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two"))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_CLOSED" },
    });
    expect(fake.requests).toHaveLength(1);
  });

  test("a failed reconnect errors the turn; later turns are CLOSED without another spawn", async () => {
    const { fake, session } = await open({ relaunch: { knownSessions: [] } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    expect(endOf(await driveTurn(session, "two")).error?.code).toBe("AGENT_SESSION_NOT_FOUND");
    expect(endOf(await driveTurn(session, "three")).error?.code).toBe("AGENT_SESSION_CLOSED");
    expect(fake.requests).toHaveLength(2);
  });

  test("tools: the reconnect gets a new tool host token and the same pre-approval (spec §6.6)", async () => {
    const tool: EmbedderTool = {
      name: "lookup",
      description: "Look a word up",
      inputSchema: { type: "object", properties: {} },
      approval: "never",
      run: async () => ({ content: "found" }),
    };
    const { fake, session } = await open({}, [tool]);
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    await driveTurn(session, "two");
    const created = JSON.parse(JSON.stringify(fake.callsTo("session/new")[0]));
    const resumed = JSON.parse(JSON.stringify(fake.callsTo("session/resume")[0]));
    expect(resumed._meta).toEqual(created._meta);
    // A new token; the port may be reused by the OS, so the URL is not compared.
    expect(resumed.mcpServers[0].headers).not.toEqual(created.mcpServers[0].headers);
  });
});

describe("cancel or close while reconnecting (Review Focus 2)", () => {
  test("cancel: the turn ends cancelled, the new process is killed, the next send tries again", async () => {
    const { fake, session } = await open({ relaunch: { hangInitialize: true } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    const iterator = await startTurn(session, () => fake.callsTo("initialize").length === 2);
    session.cancel();
    expect(endOf(await rest(iterator)).status).toBe("cancelled");
    // The in-memory launcher counts every kill: the dead process's (a no-op on a real one) and the half-started one.
    expect(fake.kills()).toBe(2);
    const again = await startTurn(session, () => fake.callsTo("initialize").length === 3);
    session.cancel();
    expect(endOf(await rest(again)).status).toBe("cancelled");
  });

  test("close: resolves, the turn ends, the half-started process is killed", async () => {
    const { fake, session } = await open({ relaunch: { hangInitialize: true } });
    await driveTurn(session, "one");
    fake.crash();
    await tick();
    const iterator = await startTurn(session, () => fake.callsTo("initialize").length === 2);
    await session.close();
    expect(endOf(await rest(iterator)).status).toBe("cancelled");
    // The dead process's kill (a no-op on a real one) and the half-started one's.
    expect(fake.kills()).toBe(2);
  });
});
