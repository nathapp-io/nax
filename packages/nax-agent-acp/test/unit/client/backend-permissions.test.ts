import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionProfile,
  createAgentSession,
  createMemoryTranscriptStore,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { ASK_REASON, FULL_REASON, NO_ALLOW_ONCE_REASON, readOnlyReason } from "#src/client/permissions";
import {
  CLAUDE_CONFIG_OPTIONS,
  type FakeScript,
  type FakeStep,
  type PermissionStep,
} from "#test/fixtures/fake-agent/script";
import { rejection, sessionError } from "#test/helpers/errors";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf, indexOfType } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const SECRET = "s3cr3t-token-value-0123";
const sessions: AgentSession[] = [];
let workdir: string;

/** Ambient secret-named env vars, held out of the resolved agent env so suites stay hermetic (env.ts SECRET_KEY). */
const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const ambientEnv: [string, string][] = [];

beforeEach(() => {
  workdir = makeTempDir("acp-perm-");
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
  cleanupTempDir(workdir);
  for (const [key, value] of ambientEnv.splice(0)) process.env[key] = value;
});

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

async function open(
  profile: AgentSessionProfile,
  steps: readonly FakeStep[],
  backend: Partial<AcpBackendOptions> = {},
  script: FakeScript = {},
): Promise<Opened> {
  const fake = inMemoryAgent({
    agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
    configOptions: CLAUDE_CONFIG_OPTIONS,
    turns: [{ steps }],
    ...script,
  });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude", ...backend }),
    profile,
    ...(profile === "none" ? {} : { workdir }),
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

const EDIT: PermissionStep = { kind: "permission", options: ["allow_once", "reject_once"] };
const RUN_TESTS: PermissionStep = {
  kind: "permission",
  options: ["allow_once", "reject_once"],
  toolCall: { kind: "execute", title: "Run tests", rawInput: { command: "bun test ./x" } },
};
const answers = (o: Opened) => o.fake.callsTo("permission-outcome");
const types = (events: readonly SessionEvent[]) => events.map((e) => e.type);
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const approvals = (events: readonly SessionEvent[]) => events.filter((e) => e.type.startsWith("approval_"));

describe("profiles none and read (spec §6.4)", () => {
  test("read: plan mode; every request rejected with a profile decision", async () => {
    const o = await open("read", [EDIT, { kind: "text", text: "done" }]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "plan" },
    ]);
    const events = await driveTurn(o.session, "edit it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(types(events)).toEqual([
      "turn_start",
      "tool_call",
      "approval_requested",
      "approval_resolved",
      "text_delta",
      "tool_result",
      "usage",
      "turn_end",
    ]);
    expect(find(events, "tool_call")).toMatchObject({ callId: "fake-permission", name: "Edit a file" });
    expect(find(events, "approval_requested")).toMatchObject({
      callId: "fake-permission",
      tool: "edit",
      summary: "Edit a file",
      reason: readOnlyReason("read"),
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
    expect(endOf(events).status).toBe("completed");
  });

  test("none, no workdir: plan mode in a scratch root; leaving plan mode (switch_mode) is rejected", async () => {
    const o = await open("none", [
      {
        kind: "permission",
        options: ["allow_always", "allow_once", "reject_once"],
        toolCall: { kind: "switch_mode", title: "Ready to code?" },
      },
    ]);
    expect(typeof o.fake.requests[0]?.cwd).toBe("string");
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "plan" },
    ]);
    await driveTurn(o.session, "plan only");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
  });

  test.each(["read", "none"] as const)(
    "%s on an agent without a read-only mode: refused after initialize",
    async (profile) => {
      const fake = inMemoryAgent({});
      _acpBackendDeps.launch = fake.launch;
      const err = sessionError(
        await rejection(
          createAgentSession({
            backend: acpBackend({ agent: "codex", allowUnsandboxed: true, command: "fake-codex" }),
            profile,
            ...(profile === "none" ? {} : { workdir }),
            transcriptStore: createMemoryTranscriptStore(),
          }),
        ),
      );
      expect(err.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
      expect(err.context).toMatchObject({ capability: "profile" });
      expect(fake.callsTo("initialize")).toHaveLength(1);
      expect(fake.callsTo("session/new")).toEqual([]);
      expect(fake.kills()).toBe(1);
    },
  );
});

describe("profile full", () => {
  test("default mode; allow_once with a profile decision; secrets scrubbed from the summary", async () => {
    const o = await open(
      "full",
      [
        {
          kind: "permission",
          options: ["allow_always", "allow_once", "reject_once"],
          toolCall: { title: `cat ${SECRET}` },
        },
      ],
      { env: { MY_TOKEN: SECRET } },
    );
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ summary: "cat [REDACTED]", reason: FULL_REASON });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "profile" });
  });

  test("no allow_once offered: denied with the reason recorded", async () => {
    const o = await open("full", [{ kind: "permission", options: ["allow_always", "reject_once"] }]);
    const events = await driveTurn(o.session, "go");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(find(events, "approval_requested")).toMatchObject({ reason: NO_ALLOW_ONCE_REASON });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "profile" });
  });

  test("a request sent after cancel(), inside the cancel grace window, is never allowed (D3-d)", async () => {
    const o = await open("full", [{ kind: "text", text: "started" }, { kind: "awaitCancel" }, EDIT]);
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "text_delta") o.session.cancel();
    });
    expect(endOf(events).status).toBe("cancelled");
    expect(answers(o)).toEqual([{ outcome: "cancelled" }]);
    expect(approvals(events)).toEqual([]);
    expect(o.fake.kills()).toBe(0);
  });
});

describe("profile ask: the caller decides through answer()", () => {
  test("allow: approval_requested carries the command; the agent gets allow_once", async () => {
    const o = await open("ask", [RUN_TESTS, { kind: "text", text: "ran" }]);
    expect(o.fake.callsTo("session/set_config_option")).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    const statuses: string[] = [];
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") statuses.push(o.session.answer(event.requestId, { decision: "allow" }));
    });
    expect(statuses).toEqual(["accepted"]);
    expect(find(events, "approval_requested")).toMatchObject({
      tool: "execute",
      summary: "Run tests",
      command: "bun test ./x",
      reason: ASK_REASON,
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-allow_once" }]);
    expect(endOf(events)).toMatchObject({ status: "completed", output: "ran" });
  });

  test("deny: the agent gets reject_once", async () => {
    const o = await open("ask", [RUN_TESTS]);
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "deny" });
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "human" });
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
  });

  test("two requests in one turn are answered independently", async () => {
    const o = await open("ask", [
      { ...RUN_TESTS, toolCall: { toolCallId: "a", kind: "edit", title: "Edit A" }, detached: true },
      { ...RUN_TESTS, toolCall: { toolCallId: "b", kind: "edit", title: "Edit B" }, detached: true },
      { kind: "settled" },
    ]);
    await driveTurn(o.session, "two", (event) => {
      if (event.type === "approval_requested") {
        o.session.answer(event.requestId, { decision: event.summary === "Edit A" ? "allow" : "deny" });
      }
    });
    expect(o.fake.callsTo("permission-answer")).toContainEqual({
      toolCallId: "a",
      outcome: { outcome: "selected", optionId: "opt-allow_once" },
    });
    expect(o.fake.callsTo("permission-answer")).toContainEqual({
      toolCallId: "b",
      outcome: { outcome: "selected", optionId: "opt-reject_once" },
    });
  });

  test("cancel while the approval is pending: the agent gets cancelled, the turn ends cancelled", async () => {
    const o = await open("ask", [RUN_TESTS, { kind: "waitForCancel" }]);
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") o.session.cancel();
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decision: "deny", decidedBy: "cancelled" });
    expect(answers(o)).toEqual([{ outcome: "cancelled" }]);
    expect(endOf(events).status).toBe("cancelled");
    expect(o.fake.kills()).toBe(0);
  });

  test("the agent ends its turn with a request unanswered: cancelled before turn_end (D3-d)", async () => {
    // The request is written to the stream before the prompt's response, so it is routed
    // while the turn is bound; the delay is margin only, not what the test relies on.
    const o = await open("ask", [
      { ...RUN_TESTS, detached: true },
      { kind: "delay", ms: 30 },
    ]);
    const events = await driveTurn(o.session, "test it");
    expect(find(events, "approval_resolved")).toMatchObject({ decidedBy: "cancelled" });
    expect(indexOfType(events, "approval_resolved")).toBeLessThan(indexOfType(events, "turn_end"));
    expect(endOf(events).status).toBe("completed");
    await waitForCondition(() => answers(o).length === 1, 2_000);
    expect(answers(o)).toEqual([{ outcome: "cancelled" }]);
  });

  test("the agent process dies while the approval is pending: cancelled; the turn ends errored", async () => {
    const o = await open("ask", [RUN_TESTS, { kind: "hang" }]);
    const events = await driveTurn(o.session, "test it", (event) => {
      if (event.type === "approval_requested") o.fake.crash();
    });
    expect(find(events, "approval_resolved")).toMatchObject({ decidedBy: "cancelled" });
    expect(indexOfType(events, "approval_resolved")).toBeLessThan(indexOfType(events, "turn_end"));
    expect(endOf(events).status).toBe("errored");
  });

  test("a request naming another agent session is rejected locally, with no event", async () => {
    // No approval_* event at all proves the decider never ran: under `ask`, any decision emits one.
    const o = await open("ask", [
      { ...RUN_TESTS, sessionId: "someone-else" },
      { kind: "text", text: "after" },
    ]);
    const events = await driveTurn(o.session, "test it");
    expect(answers(o)).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
    expect(types(events)).toEqual(["turn_start", "text_delta", "usage", "turn_end"]);
  });
});
