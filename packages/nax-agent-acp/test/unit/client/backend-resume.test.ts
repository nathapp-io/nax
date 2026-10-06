import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  createMemoryTranscriptStore,
  resumeAgentSession,
  type TranscriptStore,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep } from "#test/fixtures/fake-agent/script";
import { naxError, rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
let workdir: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-resume-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

const RESUMABLE: FakeScript = {
  agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
  configOptions: CLAUDE_CONFIG_OPTIONS,
  capabilities: { sessionCapabilities: { resume: {} } },
};

const text = (t: string): FakeStep => ({ kind: "text", text: t });
const usd = (amount: number): FakeStep => ({
  kind: "update",
  update: { sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount, currency: "USD" } },
});

interface Harness {
  readonly fake: InMemoryAgent;
  readonly store: TranscriptStore;
}

function harness(script: FakeScript = {}): Harness {
  const fake = inMemoryAgent({ ...RESUMABLE, ...script });
  _acpBackendDeps.launch = fake.launch;
  return { fake, store: createMemoryTranscriptStore() };
}

function optionsFor(h: Harness, extra: Partial<CreateAgentSessionOptions> = {}): CreateAgentSessionOptions {
  return {
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude" }),
    profile: "full",
    workdir,
    transcriptStore: h.store,
    sessionId: "s-1",
    ...extra,
  };
}

async function create(h: Harness, extra: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
  const session = await createAgentSession(optionsFor(h, extra));
  sessions.push(session);
  return session;
}

async function resume(h: Harness, extra: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
  const session = await resumeAgentSession("s-1", optionsFor(h, extra));
  sessions.push(session);
  return session;
}

const promptTexts = (fake: InMemoryAgent) =>
  fake.callsTo("session/prompt").map((p) => JSON.parse(JSON.stringify(p)).prompt[0].text);

describe("resumeAgentSession over ACP: session/resume (spec §6.9)", () => {
  test("a new process resumes the stored agent session; mode re-applied; restoredWith reported", async () => {
    const h = harness({ turns: [{ steps: [text("first")] }], relaunch: { turns: [{ steps: [text("again")] }] } });
    const first = await create(h);
    expect(endOf(await driveTurn(first, "one")).output).toBe("first");
    expect(first.backend.capabilities).not.toHaveProperty("restoredWith");
    await first.close();
    const second = await resume(h);
    expect(h.fake.requests).toHaveLength(2);
    expect(h.fake.callsTo("session/new")).toHaveLength(1);
    expect(h.fake.callsTo("session/resume")).toEqual([{ sessionId: "fake-session-1", cwd: workdir, mcpServers: [] }]);
    expect(h.fake.callsTo("session/set_config_option")).toHaveLength(2);
    expect(second.backend.capabilities).toMatchObject({ resume: true, restoredWith: "resume" });
    expect(endOf(await driveTurn(second, "two"))).toMatchObject({ status: "completed", output: "again" });
  });

  test("instructions are not sent again once a turn ran (D6-f)", async () => {
    const h = harness();
    const first = await create(h, { instructions: "Be brief." });
    await driveTurn(first, "one");
    await first.close();
    const second = await resume(h, { instructions: "Be brief." });
    await driveTurn(second, "two");
    expect(promptTexts(h.fake)).toEqual(["Be brief.\n\none", "two"]);
  });

  test("a session that never ran a turn sends its instructions with the first prompt after resume (D6-f)", async () => {
    const h = harness();
    const first = await create(h, { instructions: "Be brief." });
    await first.close();
    const second = await resume(h, { instructions: "Be brief." });
    await driveTurn(second, "hello");
    expect(promptTexts(h.fake)).toEqual(["Be brief.\n\nhello"]);
  });

  test("a turn left running by a dead process resumes as interrupted", async () => {
    const h = harness();
    const first = await create(h);
    await first.close();
    await h.store.markTurn("s-1", { turnId: "t-dead", state: "running" });
    const second = await resume(h);
    expect(second.lastTurn).toEqual({ turnId: "t-dead", status: "interrupted" });
    expect(endOf(await driveTurn(second, "go")).status).toBe("completed");
  });
});

describe("resume prices from the stored baseline (D6-a, Review Focus 3)", () => {
  test("turn 1 costs 0.01; after resume the agent reports 0.025: the turn costs 0.015", async () => {
    const h = harness({
      turns: [{ steps: [usd(0.01), text("a")] }],
      relaunch: { turns: [{ steps: [usd(0.025), text("b")] }] },
    });
    const first = await create(h);
    expect(endOf(await driveTurn(first, "one")).costUsd).toBeCloseTo(0.01, 10);
    expect((await h.store.load("s-1"))?.acp?.costUsd).toBe(0.01);
    await first.close();
    expect((await h.store.load("s-1"))?.acp?.costUsd).toBe(0.01);
    const second = await resume(h);
    const end = endOf(await driveTurn(second, "two"));
    expect(end.costSource).toBe("reported");
    expect(end.costUsd).toBeCloseTo(0.015, 10);
    expect((await h.store.load("s-1"))?.acp?.costUsd).toBe(0.025);
  });

  test("a failing baseline write is logged, not fatal", async () => {
    const h = harness({ turns: [{ steps: [usd(0.01), text("a")] }] });
    const inner = h.store;
    const store: TranscriptStore = {
      ...inner,
      save: async (id, doc) => {
        if (doc.acp?.costUsd !== undefined) throw new Error("disk full");
        await inner.save(id, doc);
      },
    };
    const session = await create({ fake: h.fake, store });
    expect(endOf(await driveTurn(session, "one")).status).toBe("completed");
  });
});

describe("resume falls back to session/load (spec §6.9 step 2, Review Focus 4)", () => {
  test("replayed history and a replayed permission request never reach the next turn", async () => {
    const replay: SessionUpdate[] = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old history" } },
      { sessionUpdate: "tool_call", toolCallId: "old-1", title: "Read", kind: "read", status: "completed" },
    ];
    const h = harness({
      capabilities: { loadSession: true },
      relaunch: { loadReplay: replay, loadPermission: true, turns: [{ steps: [text("fresh")] }] },
    });
    const first = await create(h);
    await first.close();
    const second = await resume(h);
    expect(second.backend.capabilities).toMatchObject({ restoredWith: "load" });
    expect(h.fake.callsTo("load-permission-outcome")).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    const events = await driveTurn(second, "go");
    expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []))).toEqual(["fresh"]);
    expect(events.some((e) => e.type === "tool_call" || e.type === "approval_requested")).toBe(false);
  });
});

describe("resume failures (spec §6.9, §7)", () => {
  test("the agent lost the session: AGENT_SESSION_NOT_FOUND; the new process is killed", async () => {
    const h = harness({ relaunch: { knownSessions: [] } });
    await (await create(h)).close();
    expect(sessionError(await rejection(resume(h))).code).toBe("AGENT_SESSION_NOT_FOUND");
    expect(h.fake.kills()).toBe(1);
    expect(h.fake.callsTo("session/new")).toHaveLength(1);
  });

  test("another session restored: TURN_FAILED identity", async () => {
    const h = harness({ relaunch: { restoredSessionId: "someone-else" } });
    await (await create(h)).close();
    const err = naxError(await rejection(resume(h)));
    expect(err.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(err.context).toMatchObject({ detail: "identity" });
  });

  test("an agent with neither resume nor load: CAPABILITY_UNSUPPORTED resume", async () => {
    const h = harness({ capabilities: {} });
    await (await create(h)).close();
    const err = sessionError(await rejection(resume(h)));
    expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err.context).toMatchObject({ capability: "resume" });
  });

  test("a document without its ACP record: TRANSCRIPT_CORRUPT before any spawn", async () => {
    const h = harness();
    await h.store.save("s-1", { backend: "acp:claude", messages: [], savedAt: "t" });
    expect(naxError(await rejection(resume(h))).code).toBe("TRANSCRIPT_CORRUPT");
    expect(h.fake.requests).toHaveLength(0);
  });

  test("another workdir: INVALID_OPTIONS before any spawn", async () => {
    const h = harness();
    await (await create(h)).close();
    const other = join(workdir, "other");
    mkdirSync(other);
    const err = sessionError(await rejection(resume(h, { workdir: other })));
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(h.fake.requests).toHaveLength(1);
  });

  test("the same directory through a symlink resumes, with the stored spelling sent (Review Focus 1)", async () => {
    const real = join(workdir, "real");
    mkdirSync(real);
    const link = join(workdir, "link");
    symlinkSync(real, link);
    const h = harness();
    await (await create(h, { workdir: link })).close();
    await resume(h, { workdir: real });
    expect(h.fake.callsTo("session/resume")).toEqual([{ sessionId: "fake-session-1", cwd: link, mcpServers: [] }]);
  });
});
