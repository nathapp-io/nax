import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ElicitationSchema, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  type AgentSessionProfile,
  type AnswerStatus,
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import type { AcpBackendOptions } from "#src/client/options";
import { UNANSWERED_PREVIEW } from "#src/client/tool-events";
import { CLAUDE_CONFIG_OPTIONS, type FakeScript, type FakeStep, type FakeTurn } from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { driveTurn, endOf } from "#test/helpers/session-events";

const realLaunch = _acpBackendDeps.launch;
const SECRET = "s3cr3t-token-value-0123";
const sessions: AgentSession[] = [];
let workdir: string;

beforeEach(() => {
  workdir = makeTempDir("acp-events-");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  _acpBackendDeps.launch = realLaunch;
  cleanupTempDir(workdir);
});

interface Opened {
  readonly fake: InMemoryAgent;
  readonly session: AgentSession;
}

interface OpenOptions {
  readonly profile?: AgentSessionProfile;
  readonly backend?: Partial<AcpBackendOptions>;
  readonly script?: FakeScript;
  readonly tools?: readonly EmbedderTool[];
}

async function open(turns: readonly FakeTurn[], o: OpenOptions = {}): Promise<Opened> {
  const fake = inMemoryAgent({
    agentInfo: { name: "claude-agent-acp", version: "0.85.1" },
    configOptions: CLAUDE_CONFIG_OPTIONS,
    turns,
    ...o.script,
  });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent: "claude", allowUnsandboxed: true, command: "fake-claude", ...o.backend }),
    profile: o.profile ?? "full",
    workdir,
    tools: o.tools ?? [],
    transcriptStore: createMemoryTranscriptStore(),
    sessionId: "s-1",
  });
  sessions.push(session);
  return { fake, session };
}

const update = (u: SessionUpdate): FakeStep => ({ kind: "update", update: u });
const usd = (amount: number): FakeStep =>
  update({ sessionUpdate: "usage_update", used: 100, size: 200_000, cost: { amount, currency: "USD" } });
const types = (events: readonly SessionEvent[]) => events.map((e) => e.type);
const find = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events.find((e) => e.type === type);
const texts = (events: readonly SessionEvent[], type: "text_delta" | "thinking_delta") =>
  events.flatMap((e) => (e.type === type ? [e.text] : []));

describe("tool calls and usage end to end (spec §6.7; D5-a to D5-f, D5-h)", () => {
  test("a tool call, its result, a thought, text and the turn's usage", async () => {
    const o = await open([
      {
        steps: [
          update({
            sessionUpdate: "tool_call",
            toolCallId: "toolu_1",
            name: "Read",
            title: "Read",
            kind: "read",
            status: "pending",
            rawInput: {},
          }),
          update({ sessionUpdate: "tool_call_update", toolCallId: "toolu_1", rawInput: { file_path: "/w/a.ts" } }),
          update({
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "export {}" } }],
          }),
          { kind: "thought", text: "read it" },
          { kind: "text", text: "All good" },
          usd(0.01),
        ],
        usage: { totalTokens: 175, inputTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 50 },
      },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(types(events)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "thinking_delta",
      "text_delta",
      "usage",
      "turn_end",
    ]);
    expect(find(events, "tool_call")).toMatchObject({
      callId: "toolu_1",
      name: "Read",
      input: { file_path: "/w/a.ts" },
    });
    expect(find(events, "tool_result")).toMatchObject({ callId: "toolu_1", isError: false, preview: "export {}" });
    expect(find(events, "usage")).toMatchObject({
      round: 0,
      inputTokens: 100,
      outputTokens: 25,
      cacheRead: 50,
      costUsd: 0.01,
      costSource: "reported",
    });
    expect(endOf(events)).toMatchObject({
      status: "completed",
      output: "All good",
      usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 50 },
      costUsd: 0.01,
      costSource: "reported",
    });
  });

  test("turn 2 reports its own tokens and the cost difference (Review Focus 4)", async () => {
    const o = await open([
      { steps: [usd(0.01)], usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } },
      { steps: [usd(0.025)], usage: { totalTokens: 7, inputTokens: 5, outputTokens: 2 } },
    ]);
    expect(find(await driveTurn(o.session, "one"), "usage")).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
    });
    const second = find(await driveTurn(o.session, "two"), "usage");
    expect(second).toMatchObject({ inputTokens: 5, outputTokens: 2, costSource: "reported" });
    expect(second?.type === "usage" ? second.costUsd : -1).toBeCloseTo(0.015, 10);
  });

  test("a turn with no cost is unpriced; the next priced turn carries the spend in between", async () => {
    const o = await open([{ steps: [usd(0.01)] }, { steps: [{ kind: "text", text: "x" }] }, { steps: [usd(0.04)] }]);
    await driveTurn(o.session, "one");
    expect(find(await driveTurn(o.session, "two"), "usage")).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costSource: "unpriced",
    });
    const third = find(await driveTurn(o.session, "three"), "usage");
    expect(third?.type === "usage" ? third.costUsd : -1).toBeCloseTo(0.03, 10);
  });

  test("a stop reason other than end_turn: the usage event and turn_end carry the same spend (#2367)", async () => {
    const o = await open([
      {
        steps: [usd(0.0133), { kind: "text", text: "x" }],
        stopReason: "max_tokens",
        usage: { totalTokens: 9, inputTokens: 4, outputTokens: 5 },
      },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(find(events, "usage")).toMatchObject({ inputTokens: 4, outputTokens: 5, costUsd: 0.0133 });
    expect(endOf(events)).toMatchObject({
      status: "errored",
      error: { code: "ACP_STOP_MAX_TOKENS" },
      usage: { inputTokens: 4, outputTokens: 5 },
      costUsd: 0.0133,
      costSource: "reported",
    });
  });

  test("a cancelled stop reason keeps its cost; the next turn is billed only its own delta (#2367)", async () => {
    const o = await open([
      { steps: [usd(0.0133), { kind: "text", text: "x" }], stopReason: "cancelled" },
      { steps: [usd(0.02), { kind: "text", text: "y" }] },
    ]);
    expect(endOf(await driveTurn(o.session, "one"))).toMatchObject({
      status: "errored",
      error: { code: "ACP_STOP_CANCELLED" },
      costUsd: 0.0133,
      costSource: "reported",
    });
    expect(endOf(await driveTurn(o.session, "two")).costUsd).toBeCloseTo(0.0067, 10);
  });

  test("an unpriced agent's failed turn reports costSource unpriced (#2367)", async () => {
    const o = await open([{ steps: [{ kind: "text", text: "x" }], stopReason: "refusal" }]);
    expect(endOf(await driveTurn(o.session, "go"))).toMatchObject({
      status: "errored",
      costUsd: 0,
      costSource: "unpriced",
    });
  });

  test("a call still running at turn end is answered not answered, before the usage event", async () => {
    const o = await open([
      {
        steps: [
          update({
            sessionUpdate: "tool_call",
            toolCallId: "toolu_2",
            name: "Bash",
            title: "Bash",
            status: "in_progress",
            rawInput: { command: "sleep 9" },
          }),
          { kind: "text", text: "giving up" },
        ],
      },
    ]);
    const events = await driveTurn(o.session, "go");
    expect(types(events)).toEqual(["turn_start", "tool_call", "text_delta", "tool_result", "usage", "turn_end"]);
    expect(find(events, "tool_result")).toMatchObject({
      callId: "toolu_2",
      isError: true,
      preview: UNANSWERED_PREVIEW,
    });
  });

  test("cancel answered inside the grace: the running call is answered, then usage, then turn_end with the cost (#2367)", async () => {
    const o = await open([
      {
        steps: [
          update({
            sessionUpdate: "tool_call",
            toolCallId: "toolu_3",
            name: "Bash",
            title: "Bash",
            status: "in_progress",
          }),
          { kind: "awaitCancel" },
          usd(0.01),
        ],
        stopReason: "cancelled",
      },
    ]);
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "tool_call") o.session.cancel();
    });
    expect(types(events).slice(-3)).toEqual(["tool_result", "usage", "turn_end"]);
    expect(find(events, "tool_result")).toMatchObject({ callId: "toolu_3", isError: true });
    expect(endOf(events)).toMatchObject({ status: "cancelled", costUsd: 0.01, costSource: "reported" });
  });

  test("cancel answered end_turn inside the grace: still cancelled, still priced (Review Focus 2)", async () => {
    const o = await open([{ steps: [{ kind: "awaitCancel" }, usd(0.02)], stopReason: "end_turn" }]);
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "turn_start") o.session.cancel();
    });
    expect(endOf(events)).toMatchObject({ status: "cancelled", costUsd: 0.02, costSource: "reported" });
  });

  test("cancel not answered inside the grace: no usage event, unpriced (spec §3.3)", async () => {
    const call = update({ sessionUpdate: "tool_call", toolCallId: "toolu_4", title: "Bash", status: "in_progress" });
    const o = await open([{ steps: [usd(0.01), call, { kind: "hang" }] }], { backend: { cancelGraceMs: 50 } });
    const events = await driveTurn(o.session, "one", (event) => {
      if (event.type === "tool_call") o.session.cancel();
    });
    expect(find(events, "usage")).toBeUndefined();
    expect(endOf(events)).toMatchObject({ status: "cancelled", costUsd: 0 });
  });
});

describe("agent text is scrubbed of the session's secrets (D5-g, Review Focus 1)", () => {
  test("an env secret split across text chunks, and one in a thought", async () => {
    const o = await open(
      [
        {
          steps: [
            { kind: "text", text: "key s3cr3t-tok" },
            { kind: "text", text: "en-value-0123 ok" },
            { kind: "thought", text: `t ${SECRET}` },
          ],
        },
      ],
      { backend: { env: { MY_TOKEN: SECRET } } },
    );
    const events = await driveTurn(o.session, "go");
    expect(texts(events, "text_delta").join("")).toBe("key [REDACTED] ok");
    expect(texts(events, "text_delta").some((t) => t.includes("s3cr3t") || t.includes("value-0123"))).toBe(false);
    expect(texts(events, "thinking_delta").join("")).toBe("t [REDACTED]");
    expect(endOf(events).output).toBe("key [REDACTED] ok");
  });

  test("the tool host's token echoed by the agent is scrubbed from text and output", async () => {
    const lookup: EmbedderTool = {
      name: "lookup",
      description: "Look a word up",
      inputSchema: { type: "object" },
      approval: "never",
      run: async () => ({ content: "found" }),
    };
    const o = await open([{ steps: [{ kind: "text", text: "auth=", echoMcpAuth: true }] }], {
      tools: [lookup],
      script: { capabilities: { mcpCapabilities: { http: true } } },
    });
    const events = await driveTurn(o.session, "go");
    expect(texts(events, "text_delta").join("")).toBe("auth=Bearer [REDACTED]");
    expect(endOf(events).output).toBe("auth=Bearer [REDACTED]");
  });
});

/** Claude's AskUserQuestion with one question: a titled oneOf plus its "Other" companion. */
const AUTH_FORM: ElicitationSchema = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Auth",
      oneOf: [
        { const: "OAuth", title: "OAuth" },
        { const: "API key", title: "API key" },
      ],
    },
    question_0_custom: { type: "string", title: "Other" },
  },
};
const ASK_AUTH: FakeStep = { kind: "elicit", message: "Which auth?", requestedSchema: AUTH_FORM };

describe("elicitation end to end (spec §6.8; D5-i to D5-l, Review Focus 2 and 3)", () => {
  test.each(["ask", "full"] as const)(
    "under %s: a question round trip; the agent gets the form content",
    async (profile) => {
      const o = await open([{ steps: [ASK_AUTH, { kind: "text", text: "ok" }] }], { profile });
      const statuses: AnswerStatus[] = [];
      const events = await driveTurn(o.session, "go", (event) => {
        if (event.type === "question") statuses.push(o.session.answer(event.requestId, { text: "2" }));
      });
      expect(statuses).toEqual(["accepted"]);
      const question = find(events, "question");
      expect(question?.type === "question" ? question.text : "").toContain("2. API key");
      expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "accept", content: { question_0: "API key" } }]);
      expect(endOf(events).status).toBe("completed");
    },
  );

  test("a free-text reply becomes Claude's 'Other' answer", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "ask" });
    await driveTurn(o.session, "go", (event) => {
      if (event.type === "question") o.session.answer(event.requestId, { text: "mTLS" });
    });
    expect(o.fake.callsTo("elicitation-answer")).toEqual([
      { action: "accept", content: { question_0_custom: "mTLS" } },
    ]);
  });

  test("under read: elicitation is not advertised, and a stray one is declined unasked", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "read" });
    const events = await driveTurn(o.session, "go");
    expect(JSON.stringify(o.fake.callsTo("initialize"))).not.toContain("elicitation");
    expect(find(events, "question")).toBeUndefined();
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "decline" }]);
  });

  test("a request-scoped elicitation is cancelled with no event", async () => {
    const o = await open([{ steps: [{ ...ASK_AUTH, scope: "request" }] }], { profile: "ask" });
    const events = await driveTurn(o.session, "go");
    expect(find(events, "question")).toBeUndefined();
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "cancel" }]);
  });

  test("cancel during a question: it settles cancelled and the agent's form is cancelled", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "ask" });
    let questionId = "";
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "question") {
        questionId = event.requestId;
        o.session.cancel();
      }
    });
    expect(endOf(events).status).toBe("cancelled");
    expect(o.session.answer(questionId, { text: "late" })).toBe("cancelled");
    await waitForCondition(() => o.fake.callsTo("elicitation-answer").length > 0, 2_000);
    expect(o.fake.callsTo("elicitation-answer")).toEqual([{ action: "cancel" }]);
  });

  test("the agent process dies during a question: it settles cancelled at once (D5-j)", async () => {
    const o = await open([{ steps: [ASK_AUTH] }], { profile: "ask" });
    let questionId = "";
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "question") {
        questionId = event.requestId;
        o.fake.crash();
      }
    });
    expect(endOf(events).status).toBe("errored");
    expect(o.session.answer(questionId, { text: "late" })).toBe("cancelled");
  });

  test("a permission request's tool call and its approval come in that order (D5-c)", async () => {
    const o = await open(
      [
        {
          steps: [
            {
              kind: "permission",
              options: ["allow_once", "reject_once"],
              toolCall: {
                toolCallId: "toolu_9",
                title: "Run tests",
                kind: "execute",
                rawInput: { command: "bun test" },
              },
            },
            update({
              sessionUpdate: "tool_call_update",
              toolCallId: "toolu_9",
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "3 pass" } }],
            }),
          ],
        },
      ],
      { profile: "ask" },
    );
    const events = await driveTurn(o.session, "go", (event) => {
      if (event.type === "approval_requested") o.session.answer(event.requestId, { decision: "allow" });
    });
    expect(types(events)).toEqual([
      "turn_start",
      "tool_call",
      "approval_requested",
      "approval_resolved",
      "tool_result",
      "usage",
      "turn_end",
    ]);
    expect(find(events, "approval_requested")).toMatchObject({ callId: "toolu_9" });
    expect(find(events, "tool_result")).toMatchObject({ callId: "toolu_9", isError: false, preview: "3 pass" });
  });
});
