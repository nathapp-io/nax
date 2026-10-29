/**
 * acp-tools-codex-cursor US-004: Codex and Cursor sessions under `ask` allow their own
 * tool host's calls once, proven by the structured report sent before the permission
 * request in the same turn; anything else is still a card (or the profile's decision).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { ASK_REASON, OWN_TOOL_REASON } from "#src/client/permissions";
import {
  CLAUDE_CONFIG_OPTIONS,
  CODEX_CONFIG_OPTIONS,
  CURSOR_CONFIG_OPTIONS,
  type FakeStep,
  type FakeTurn,
} from "#test/fixtures/fake-agent/script";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const realName = _acpBackendDeps.newToolHostServerName;
const SERVER = "nax-0badc0de";
const sessions: AgentSession[] = [];
let workdir: string;

/** Ambient secret-named env vars, held out of the resolved agent env so the suite stays hermetic (env.ts SECRET_KEY). */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const ambientEnv: [string, string][] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-own-approval-");
  _acpBackendDeps.newToolHostServerName = () => SERVER;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SECRET_KEY.test(key)) {
      ambientEnv.push([key, value]);
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  _acpBackendDeps.newToolHostServerName = realName;
  cleanupTempDir(workdir);
  for (const [key, value] of ambientEnv.splice(0)) process.env[key] = value;
});

const LOOKUP: EmbedderTool = {
  name: "lookup",
  description: "Look a word up",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  approval: "never",
  run: async () => ({ content: "found" }),
};

type Agent = "cursor" | "codex" | "claude";
const CONFIG = {
  cursor: CURSOR_CONFIG_OPTIONS,
  codex: CODEX_CONFIG_OPTIONS,
  claude: CLAUDE_CONFIG_OPTIONS,
} as const;

async function open(agent: Agent, turns: readonly FakeTurn[], profile: AgentSessionProfile = "ask") {
  const fake = inMemoryAgent({
    agentInfo: { name: `${agent}-acp`, version: "1.0.0" },
    configOptions: CONFIG[agent],
    capabilities: { mcpCapabilities: { http: true } },
    turns,
  });
  _acpBackendDeps.launch = fake.launch;
  const options: AcpBackendOptions = { agent, allowUnsandboxed: true, command: "fake-agent" };
  const session = await createAgentSession({
    backend: acpBackend(options),
    profile,
    workdir,
    tools: [LOOKUP],
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

const cursorReport = (id: string, server: string, tool = "lookup"): FakeStep => ({
  kind: "update",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    rawInput: { providerIdentifier: server, toolName: tool, args: {} },
  },
});

const ask = (id: string): FakeStep => ({
  kind: "permission",
  options: ["allow_once", "reject_once"],
  toolCall: { toolCallId: id, kind: "other", title: "lookup" },
});

/** Runs a turn, answering every human card with `decision` so a negative case cannot stall. */
async function drive(session: AgentSession, decision: "allow" | "deny" = "allow"): Promise<SessionEvent[]> {
  const events = await driveTurn(session, "go", (event) => {
    if (event.type === "approval_requested" && event.answerable !== false) {
      session.answer(event.requestId, { decision });
    }
  });
  expect(endOf(events).status).toBe("completed");
  return events;
}

const requested = (events: readonly SessionEvent[]) => events.filter((e) => e.type === "approval_requested");
/** The approval_requested events a person was asked to answer. */
const cardsOf = (events: readonly SessionEvent[]) =>
  events.filter((e) => e.type === "approval_requested" && e.answerable !== false);
const answers = (o: { fake: ReturnType<typeof inMemoryAgent> }) => o.fake.callsTo("permission-answer");
const ALLOW = { outcome: "selected", optionId: "opt-allow_once" };

describe("cursor: a proven own tool call is allowed once under ask", () => {
  test("AC-8/9/10: the agent gets allow-once, no answerable card, one informational event with OWN_TOOL_REASON", async () => {
    const o = await open("cursor", [{ steps: [cursorReport("t1", SERVER), ask("t1")] }]);
    const events = await drive(o.session);
    expect(answers(o)).toEqual([{ toolCallId: "t1", outcome: ALLOW }]);
    expect(cardsOf(events)).toEqual([]);
    expect(requested(events)).toMatchObject([{ answerable: false, reason: OWN_TOOL_REASON }]);
  });

  test("AC-11: the report names the fixed server nax: a card with ASK_REASON", async () => {
    const o = await open("cursor", [{ steps: [cursorReport("t1", "nax"), ask("t1")] }]);
    const events = await drive(o.session);
    const cards = requested(events);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason: ASK_REASON });
    expect(cardsOf(events)).toHaveLength(1);
  });

  test("AC-12: a report in the first prompt does not prove the request in the second", async () => {
    const o = await open("cursor", [{ steps: [cursorReport("t1", SERVER)] }, { steps: [ask("t1")] }]);
    const first = await drive(o.session);
    expect(requested(first)).toEqual([]);
    const second = await drive(o.session);
    const cards = requested(second);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason: ASK_REASON });
    expect(cardsOf(second)).toHaveLength(1);
  });

  test("AC-16: an id never reported with structured fields is a card, as today", async () => {
    const o = await open("cursor", [{ steps: [ask("t9")] }]);
    const events = await drive(o.session);
    const cards = requested(events);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason: ASK_REASON });
    expect(cardsOf(events)).toHaveLength(1);
  });

  test("AC-18: the own server but a tool outside the session's tools is a card", async () => {
    const o = await open("cursor", [{ steps: [cursorReport("t1", SERVER, "other"), ask("t1")] }]);
    const events = await drive(o.session);
    expect(requested(events)).toHaveLength(1);
    expect(requested(events)[0]).toMatchObject({ reason: ASK_REASON });
    expect(cardsOf(events)).toHaveLength(1);
  });

  test("AC-19: two different identities for one id: a card, not own", async () => {
    const o = await open("cursor", [
      { steps: [cursorReport("t1", SERVER), cursorReport("t1", "nax-deadbeef"), ask("t1")] },
    ]);
    const events = await drive(o.session);
    const cards = requested(events);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason: ASK_REASON });
    expect(cardsOf(events)).toHaveLength(1);
  });
});

describe("codex: a proven own tool call is allowed once under ask", () => {
  test("AC-13/14: a tool_call report for t2 then a request: allow-once, no answerable card", async () => {
    const report: FakeStep = {
      kind: "update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "lookup",
        rawInput: { server: SERVER, tool: "lookup", arguments: {} },
      },
    };
    const o = await open("codex", [{ steps: [report, ask("t2")] }]);
    const events = await drive(o.session);
    expect(answers(o)).toEqual([{ toolCallId: "t2", outcome: ALLOW }]);
    expect(cardsOf(events)).toEqual([]);
    expect(requested(events)).toMatchObject([{ answerable: false, reason: OWN_TOOL_REASON }]);
  });
});

describe("claude has no MCP call identity, so no ledger", () => {
  test("AC-15: a Cursor-shaped report naming the session's server still gets a card", async () => {
    const o = await open("claude", [{ steps: [cursorReport("t1", SERVER), ask("t1")] }]);
    const events = await drive(o.session);
    const cards = requested(events);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason: ASK_REASON });
    expect(cardsOf(events)).toHaveLength(1);
  });
});
