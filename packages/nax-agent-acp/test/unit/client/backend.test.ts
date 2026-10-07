import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  createMemoryTranscriptStore,
  type SessionEvent,
  type TranscriptDoc,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import * as publicClient from "#src/client/index";
import type { AcpBackendOptions } from "#src/client/options";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript } from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";

const realLaunch = _acpBackendDeps.launch;
const SECRET = "s3cr3t-token-value-0123";
let workdir: string;

/** Ambient secret-named env vars, held out of the resolved agent env so suites stay hermetic (env.ts SECRET_KEY). */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const ambientEnv: [string, string][] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-backend-");
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SECRET_KEY.test(key)) {
      ambientEnv.push([key, value]);
      delete process.env[key];
    }
  }
});

afterEach(() => {
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
  for (const [key, value] of ambientEnv.splice(0)) process.env[key] = value;
});

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
  readonly saves: TranscriptDoc[];
  readonly store: TranscriptStore;
}

function recordingStore(): { store: TranscriptStore; saves: TranscriptDoc[] } {
  const inner = createMemoryTranscriptStore();
  const saves: TranscriptDoc[] = [];
  const store: TranscriptStore = {
    ...inner,
    save: async (id, doc) => {
      saves.push(doc);
      await inner.save(id, doc);
    },
  };
  return { store, saves };
}

async function open(
  script: FakeScript = {},
  backend: Partial<AcpBackendOptions> = {},
  session: Partial<CreateAgentSessionOptions> = {},
): Promise<Opened> {
  const fake = inMemoryAgent({
    agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
    configOptions: CLAUDE_CONFIG_OPTIONS,
    ...script,
  });
  _acpBackendDeps.launch = fake.launch;
  const { store, saves } = recordingStore();
  const created = await createAgentSession({
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude", ...backend }),
    profile: "full",
    workdir,
    transcriptStore: store,
    sessionId: "s-1",
    ...session,
  });
  return { fake, session: created, saves, store };
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

async function cancelMidTurn(o: Opened, message: string): Promise<SessionEvent[]> {
  const promptsBefore = o.fake.callsTo("session/prompt").length;
  const iterator = o.session.send(message)[Symbol.asyncIterator]();
  const first = await iterator.next();
  await waitForCondition(() => o.fake.callsTo("session/prompt").length > promptsBefore, 2_000);
  o.session.cancel();
  const rest: SessionEvent[] = first.done === true ? [] : [first.value];
  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) rest.push(next.value);
  return rest;
}

describe("acpBackend: a text-only full session end to end (spec §10 S4-2)", () => {
  test("text deltas, turn_end, backend info and what reached the agent", async () => {
    const o = await open({
      turns: [
        {
          steps: [
            { kind: "text", text: "Hel" },
            { kind: "text", text: "lo" },
          ],
        },
      ],
    });
    const events = await drain(o.session.send("hi"));
    expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []))).toEqual(["Hel", "lo"]);
    expect(endOf(events)).toMatchObject({
      status: "completed",
      output: "Hello",
      costUsd: 0,
      costSource: "unpriced",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(o.session.backend.kind).toBe("acp:claude");
    expect(o.session.backend.capabilities).toMatchObject({
      protocolVersion: 1,
      agentName: "claude-agent-acp",
      agentVersion: "0.85.1",
      readOnlyMode: true,
      preApproval: true,
    });
    expect(o.fake.callsTo("session/prompt")).toEqual([
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "hi" }] },
    ]);
    await o.session.close();
  });

  test("instructions are prepended to the first prompt only", async () => {
    const o = await open({}, {}, { instructions: "Be brief." });
    await drain(o.session.send("first"));
    await drain(o.session.send("second"));
    expect(o.fake.callsTo("session/prompt")).toEqual([
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "Be brief.\n\nfirst" }] },
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "second" }] },
    ]);
    await o.session.close();
  });

  test("a JSON-RPC error on the first prompt is not receipt: the next prompt carries the instructions (#2364, F7)", async () => {
    const o = await open(
      { turns: [{ steps: [{ kind: "fail", failure: { code: -32603, message: "boom" } }] }, { steps: [] }] },
      {},
      { instructions: "Be brief." },
    );
    await drain(o.session.send("first"));
    await drain(o.session.send("second"));
    expect(o.fake.callsTo("session/prompt")).toEqual([
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "Be brief.\n\nfirst" }] },
      { sessionId: "fake-session-1", prompt: [{ type: "text", text: "Be brief.\n\nsecond" }] },
    ]);
    await o.session.close();
  });

  test("the initial document records the agent session", async () => {
    const o = await open();
    expect(await o.store.load("s-1")).toMatchObject({
      backend: "acp:claude",
      acp: { agentSessionId: "fake-session-1", agent: "claude", agentVersion: "0.85.1", cwd: workdir },
      messages: [],
    });
    await o.session.close();
  });

  test("a custom agent sets no mode and reports kind acp:<name>", async () => {
    const fake = inMemoryAgent({});
    _acpBackendDeps.launch = fake.launch;
    const session = await createAgentSession({
      backend: acpBackend({ agent: { name: "my-agent", command: "my-agent-acp" }, allowUnsandboxed: true }),
      profile: "full",
      workdir,
      transcriptStore: createMemoryTranscriptStore(),
    });
    expect(session.backend.kind).toBe("acp:my-agent");
    expect(fake.callsTo("session/set_config_option")).toEqual([]);
    expect(endOf(await drain(session.send("x"))).status).toBe("completed");
    await session.close();
  });

  test("updates addressed to another session are ignored", async () => {
    const o = await open({
      turns: [
        {
          steps: [
            { kind: "text", text: "mine" },
            { kind: "text", text: "theirs", sessionId: "other" },
          ],
        },
      ],
    });
    expect(endOf(await drain(o.session.send("x"))).output).toBe("mine");
    await o.session.close();
  });
});

describe("acpBackend: turn outcomes (spec §5.7, §7)", () => {
  test.each([
    ["max_tokens", "ACP_STOP_MAX_TOKENS"],
    ["max_turn_requests", "ACP_STOP_MAX_TURN_REQUESTS"],
    ["refusal", "ACP_STOP_REFUSAL"],
    ["cancelled", "ACP_STOP_CANCELLED"],
  ] as const)("stop reason %s ends the turn errored with %s", async (stopReason, code) => {
    const o = await open({ turns: [{ steps: [{ kind: "text", text: "x" }], stopReason }] });
    expect(endOf(await drain(o.session.send("x")))).toMatchObject({ status: "errored", error: { code } });
    await o.session.close();
  });

  test("a JSON-RPC error on prompt is AGENT_SESSION_TURN_FAILED, redacted; the session stays usable", async () => {
    const o = await open(
      {
        turns: [
          { steps: [{ kind: "fail", failure: { code: -32603, message: `overloaded ${SECRET}` } }] },
          { steps: [{ kind: "text", text: "ok" }] },
        ],
      },
      { env: { MY_TOKEN: SECRET } },
    );
    const failed = endOf(await drain(o.session.send("x")));
    expect(failed).toMatchObject({ status: "errored", error: { code: "AGENT_SESSION_TURN_FAILED" } });
    expect(failed.error?.message).not.toContain(SECRET);
    expect(endOf(await drain(o.session.send("y")))).toMatchObject({ status: "completed", output: "ok" });
    await o.session.close();
  });

  test("an auth error on prompt is AGENT_SESSION_AUTH_REQUIRED", async () => {
    const o = await open({ turns: [{ steps: [{ kind: "fail", failure: { code: -32000, message: "expired" } }] }] });
    expect(endOf(await drain(o.session.send("x")))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_AUTH_REQUIRED" },
    });
    await o.session.close();
  });
});

describe("acpBackend: cancel (spec §6.3 step 3)", () => {
  test("an agent that honours session/cancel: cancelled, and the session stays usable", async () => {
    const o = await open({
      turns: [{ steps: [{ kind: "waitForCancel" }] }, { steps: [{ kind: "text", text: "again" }] }],
    });
    expect(endOf(await cancelMidTurn(o, "go")).status).toBe("cancelled");
    expect(o.fake.callsTo("session/cancel")).toEqual([{ sessionId: "fake-session-1" }]);
    expect(o.fake.kills()).toBe(0);
    expect(endOf(await drain(o.session.send("next")))).toMatchObject({ status: "completed", output: "again" });
    await o.session.close();
  });

  test("an agent that ignores it: killed after cancelGraceMs; later turns end AGENT_SESSION_CLOSED (D-f)", async () => {
    const o = await open({ turns: [{ steps: [{ kind: "hang" }] }] }, { cancelGraceMs: 50 });
    expect(endOf(await cancelMidTurn(o, "go")).status).toBe("cancelled");
    expect(o.fake.kills()).toBe(1);
    expect(endOf(await drain(o.session.send("next")))).toMatchObject({
      status: "errored",
      error: { code: "AGENT_SESSION_CLOSED" },
    });
    await o.session.close();
    expect(o.fake.callsTo("session/close")).toEqual([]);
  });
});

describe("acpBackend: close (spec §6.3 step 4, D-j)", () => {
  test("session/close when advertised, terminate, a final save that keeps the turn marker; idempotent", async () => {
    const o = await open({ capabilities: { sessionCapabilities: { close: {} } } });
    await drain(o.session.send("x"));
    await o.session.close();
    await o.session.close();
    expect(o.fake.callsTo("session/close")).toEqual([{ sessionId: "fake-session-1" }]);
    expect(o.fake.terminations()).toBe(1);
    expect(o.saves).toHaveLength(2);
    expect(o.saves.at(-1)?.turn?.state).toBe("ended");
    expect(o.saves.at(-1)?.backend).toBe("acp:claude");
  });

  test("no session/close when the agent does not advertise it", async () => {
    const o = await open();
    await o.session.close();
    expect(o.fake.callsTo("session/close")).toEqual([]);
    expect(o.fake.terminations()).toBe(1);
  });
});

describe("the public entry", () => {
  test("./client exports acpBackend, ACP_STOP_CODES and the launcher checks (S4b)", () => {
    expect(Object.keys(publicClient).sort()).toEqual([
      "ACP_STOP_CODES",
      "acpBackend",
      "isAgentLaunchable",
      "launchCandidateKind",
    ]);
  });
});
