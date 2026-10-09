import { describe, expect, test } from "bun:test";
import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import { createServerSession, TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import type { OldText } from "#src/server/translate/diff";
import { FAR_EXPIRY, fakeAgentSession, type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { ALL_FEATURES, type FakePortOptions, fakePort, select } from "#test/helpers/fake-client-port";
import { recordingLogger } from "#test/helpers/recording-logger";

const missing = async (): Promise<OldText> => ({ kind: "missing" });

function setup(scripts: readonly Script[], portOptions: FakePortOptions = {}, contextWindow?: number) {
  const fake = fakeAgentSession("s1", scripts);
  const port = fakePort(portOptions);
  const { logger, lines } = recordingLogger();
  const session = createServerSession({
    session: fake.session,
    port: port.port,
    cwd: "/w",
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    readOldText: missing,
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  return { fake, port, lines, session };
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const kinds = (updates: readonly SessionUpdate[]) => updates.map((u) => u.sessionUpdate);

async function failure(promise: Promise<unknown>): Promise<RequestError> {
  const caught = await promise.catch((e: unknown) => e);
  if (caught instanceof RequestError) return caught;
  throw new Error(`expected a RequestError, got ${String(caught)}`);
}

const hello: Script = async function* () {
  yield { type: "turn_start" };
  yield { type: "text_delta", round: 1, text: "Hel" };
  yield { type: "text_delta", round: 1, text: "lo" };
  yield turnEnd("completed", { output: "Hello" });
};

describe("prompt", () => {
  test("streams text and answers end_turn with the turn usage", async () => {
    const s = setup([hello]);
    const response = await s.session.prompt(text("hi"));
    expect(s.fake.messages).toEqual(["hi"]);
    expect(kinds(s.port.updates)).toEqual(["agent_message_chunk", "agent_message_chunk"]);
    expect(response).toEqual({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(s.session.running).toBe(false);
    expect(s.session.id).toBe("s1");
  });

  test("a queued notice is the first update of the next turn (M-11)", async () => {
    const s = setup([hello]);
    s.session.queueNotice({ sessionUpdate: "notice", severity: "warning", title: "queued" });
    await s.session.prompt(text("hi"));
    expect(s.port.updates[0]).toMatchObject({ title: "queued" });
  });

  test("invalid content is invalid_params and nothing is sent", async () => {
    const s = setup([hello]);
    expect((await failure(s.session.prompt([]))).code).toBe(-32602);
    expect(s.fake.messages).toEqual([]);
    expect(s.session.running).toBe(false);
  });

  test("a second prompt while a turn runs is turn in progress", async () => {
    const slow: Script = async function* ({ cancelled }) {
      yield { type: "turn_start" };
      await cancelled;
      yield turnEnd("cancelled");
    };
    const s = setup([slow]);
    const first = s.session.prompt(text("one"));
    expect(s.session.running).toBe(true);
    expect((await failure(s.session.prompt(text("two")))).message).toContain("turn in progress");
    s.session.cancel();
    expect((await first).stopReason).toBe("cancelled");
  });

  test("an errored turn is internal_error with the turn's code and message", async () => {
    const broken: Script = async function* () {
      yield turnEnd("errored", { error: { code: "PROVIDER_DOWN", message: "provider down" } });
    };
    const error = await failure(setup([broken]).session.prompt(text("hi")));
    expect(error.code).toBe(-32603);
    expect(error.data).toEqual({ code: "PROVIDER_DOWN", message: "provider down" });
  });

  test("a turn that ends without turn_end is internal_error", async () => {
    const cut: Script = async function* () {
      yield { type: "turn_start" };
    };
    expect((await failure(setup([cut]).session.prompt(text("hi")))).code).toBe(-32603);
  });

  test("a timed-out turn ends max_turn_requests after a notice naming the limit", async () => {
    const late: Script = async function* () {
      yield turnEnd("timed_out");
    };
    const s = setup([late], { features: ALL_FEATURES });
    expect((await s.session.prompt(text("hi"))).stopReason).toBe("max_turn_requests");
    expect(JSON.stringify(s.port.updates.at(-1))).toContain(`${TURN_TIMEOUT_SECONDS}s`);
  });

  test("usage cost accumulates across turns", async () => {
    const priced = (cost: number): Script =>
      async function* () {
        yield { type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd: cost };
        yield turnEnd("completed");
      };
    const s = setup([priced(0.5), priced(0.25)], {}, 200_000);
    await s.session.prompt(text("a"));
    await s.session.prompt(text("b"));
    const usage = s.port.updates.filter((u) => u.sessionUpdate === "usage_update");
    expect(usage.map((u) => (u.sessionUpdate === "usage_update" ? u.cost?.amount : undefined))).toEqual([0.5, 0.75]);
  });
});

function editApproval(requestId: string, extra: { answerable?: false } = {}): Script {
  return async function* ({ reply }) {
    yield { type: "turn_start" };
    yield { type: "tool_call", callId: "c1", name: "Edit", input: { path: "a.ts", old_string: "a", new_string: "b" } };
    yield {
      type: "approval_requested",
      requestId,
      callId: "c1",
      tool: "Edit",
      summary: "Edit a.ts",
      reason: "ask profile",
      expiresAt: FAR_EXPIRY,
      ...extra,
    };
    if (extra.answerable === false) {
      yield { type: "approval_resolved", requestId, decision: "deny", decidedBy: "profile" };
      yield turnEnd("completed");
      return;
    }
    const got = await reply(requestId);
    const allowed = got !== "cancelled" && "decision" in got && got.decision === "allow";
    yield {
      type: "approval_resolved",
      requestId,
      decision: allowed ? "allow" : "deny",
      decidedBy: got === "cancelled" ? "cancelled" : "human",
    };
    yield turnEnd(got === "cancelled" ? "cancelled" : "completed");
  };
}

describe("approvals", () => {
  test("asks the client with the translated tool call and its diff, then answers", async () => {
    const s = setup([editApproval("r1")]);
    expect((await s.session.prompt(text("edit"))).stopReason).toBe("end_turn");
    expect(s.port.asks[0]?.toolCall).toMatchObject({ toolCallId: "c1", kind: "edit", status: "pending" });
    expect(JSON.stringify(s.port.asks[0]?.toolCall.content)).toContain('"oldText":"a"');
    expect(s.fake.answers).toEqual([{ requestId: "r1", reply: { decision: "allow" } }]);
  });

  test("allow_always carries over to the next turn of the same session", async () => {
    const s = setup([editApproval("r1"), editApproval("r2")], { permission: async () => select("allow_always") });
    await s.session.prompt(text("one"));
    await s.session.prompt(text("two"));
    expect(s.port.asks).toHaveLength(1);
    expect(s.fake.answers.map((a) => a.requestId)).toEqual(["r1", "r2"]);
  });

  test("an unanswerable approval sends no permission request (M-1)", async () => {
    const s = setup([editApproval("r1", { answerable: false })]);
    await s.session.prompt(text("edit"));
    expect(s.port.asks).toEqual([]);
    expect(s.port.updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  });

  test("cancel during an open permission request aborts it and ends cancelled", async () => {
    const s = setup([editApproval("r1")], { permission: () => new Promise(() => {}) });
    const pending = s.session.prompt(text("edit"));
    await waitForCondition(() => s.port.asks.length > 0);
    s.session.cancel();
    expect((await pending).stopReason).toBe("cancelled");
    expect(s.port.signals[0]?.aborted).toBe(true);
    expect(s.fake.cancels()).toBe(1);
    expect(s.fake.answers).toEqual([]);
  });

  test("cancel with no turn running is passed to the S3 session and nothing else", () => {
    const s = setup([]);
    s.session.cancel();
    expect(s.fake.cancels()).toBe(1);
  });
});

describe("questions", () => {
  test("a question without elicitation support is answered with the fallback text", async () => {
    const asks: Script = async function* ({ reply }) {
      yield { type: "question", requestId: "q1", text: "Which env?", expiresAt: FAR_EXPIRY };
      const got = await reply("q1");
      yield { type: "text_delta", round: 1, text: got !== "cancelled" && "text" in got ? got.text : "" };
      yield turnEnd("completed");
    };
    const s = setup([asks]);
    await s.session.prompt(text("go"));
    expect(JSON.stringify(s.port.updates.at(-1))).toContain("No answer available");
  });
});

describe("a broken client connection", () => {
  test("cancels the turn, drains it and fails the prompt with internal_error", async () => {
    const chatty: Script = async function* ({ cancelled }) {
      yield { type: "text_delta", round: 1, text: "a" };
      await cancelled;
      yield turnEnd("cancelled");
    };
    const s = setup([chatty], { failUpdates: true });
    const error = await failure(s.session.prompt(text("hi")));
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("client connection closed");
    expect(s.fake.cancels()).toBe(1);
    expect(s.session.running).toBe(false);
    expect(s.lines.some((l) => l.level === "warn")).toBe(true);
  });
});

describe("close", () => {
  test("closes the S3 session", async () => {
    const s = setup([]);
    await s.session.close();
    expect(s.fake.closed()).toBe(true);
  });
});
