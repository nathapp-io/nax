import { describe, expect, mock, test } from "bun:test";
import type { AnswerReply, SessionEvent } from "@nathapp/nax-agent";
import * as chat from "@/chat";

type Approval = Extract<SessionEvent, { type: "approval_requested" }>;
const base = { sessionId: "s1", turnId: "t1", at: "2026-10-20T00:00:00Z", metadata: {} };
function approval(requestId = "r1", overrides: Partial<Approval> = {}): Approval {
  return {
    ...base,
    type: "approval_requested",
    requestId,
    tool: "Bash",
    command: "npm test",
    summary: "Run tests",
    reason: "Approval required",
    expiresAt: "2026-10-20T01:00:00Z",
    ...overrides,
  };
}
function question(requestId = "q1"): Extract<SessionEvent, { type: "question" }> {
  return { ...base, type: "question", requestId, text: "Continue?", expiresAt: "2026-10-20T01:00:00Z" };
}
function setup(mode: chat.ChatMode = "guarded") {
  const answer = mock((_id: string, _reply: AnswerReply) => "accepted" as const);
  return { asks: chat.createChatAskController({ mode, answer }), answer };
}

describe("createChatAskController", () => {
  test("AC-1: full mode answers an approval exactly once", () => {
    const { asks, answer } = setup("full");
    asks.handle(approval());
    expect(answer.mock.calls).toEqual([["r1", { decision: "allow" }]]);
    expect(asks.pending()).toEqual([]);
  });
  test("AC-2: informational approvals are ignored", () => {
    const { asks, answer } = setup("full");
    asks.handle(approval("r1", { answerable: false }));
    expect(answer).not.toHaveBeenCalled();
    expect(asks.pending()).toEqual([]);
  });
  test("AC-3: guarded approvals wait without answering", () => {
    const { asks, answer } = setup();
    const event = approval();
    asks.handle(event);
    expect(asks.pending()).toEqual([event]);
    expect(answer).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-4", "allow_once", "allow"],
    ["AC-5", "deny", "deny"],
  ] as const)("%s: resolving %s dispatches %s", (_ac, choice, decision) => {
    const { asks, answer } = setup();
    asks.handle(approval());
    asks.resolve("r1", choice);
    expect(answer.mock.calls).toEqual([["r1", { decision }]]);
    expect(asks.pending()).toEqual([]);
  });
  test("AC-6: session allow answers a matching command immediately", () => {
    const { asks, answer } = setup();
    asks.handle(approval());
    asks.resolve("r1", "allow_session");
    asks.handle(approval("r2"));
    expect(answer.mock.calls).toEqual([
      ["r1", { decision: "allow" }],
      ["r2", { decision: "allow" }],
    ]);
    expect(asks.pending()).toEqual([]);
  });
  test.each([
    ["AC-7", { command: "npm test; rm -rf x" }],
    ["AC-8", { unsandboxed: true }],
  ] satisfies [string, Partial<Approval>][])("%s: memory cannot approve unsafe requests", (_ac, overrides) => {
    const { asks, answer } = setup();
    asks.handle(approval());
    asks.resolve("r1", "allow_session");
    const next = approval("r2", overrides);
    asks.handle(next);
    expect(asks.pending()).toEqual([next]);
    expect(answer).toHaveBeenCalledTimes(1);
  });
  test("AC-9: deny never creates memory", () => {
    const { asks, answer } = setup();
    asks.handle(approval());
    asks.resolve("r1", "deny");
    const next = approval("r2");
    asks.handle(next);
    expect(asks.pending()).toEqual([next]);
    expect(answer).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["AC-10", { command: "rm -f x" }],
    ["AC-11", { unsandboxed: true }],
    ["AC-12", { tool: "Delete", command: undefined }],
  ] satisfies [string, Partial<Approval>][])("%s: cannot remember this request", (_ac, overrides) => {
    const { asks } = setup();
    expect(asks.canRemember(approval("r1", overrides))).toBe(false);
  });
  test.each([
    { command: "rm -f x" },
    { unsandboxed: true },
    { tool: "Delete", command: undefined },
  ] satisfies Partial<Approval>[])("AC-13: allow_session degrades to allow_once for %j", (overrides) => {
    const { asks, answer } = setup();
    asks.handle(approval("r1", overrides));
    asks.resolve("r1", "allow_session");
    const next = approval("r2", overrides);
    asks.handle(next);
    expect(answer.mock.calls).toEqual([["r1", { decision: "allow" }]]);
    expect(asks.pending()).toEqual([next]);
  });
  test("AC-14: external resolution removes the pending request without answering", () => {
    const { asks, answer } = setup();
    asks.handle(approval());
    asks.handle({ ...base, type: "approval_resolved", requestId: "r1", decision: "deny", decidedBy: "timeout" });
    expect(asks.pending()).toEqual([]);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-15: full mode still queues questions", () => {
    const { asks, answer } = setup("full");
    const event = question();
    asks.handle(event);
    expect(asks.pending()).toEqual([event]);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-16: question answer dispatches text and removes the question", () => {
    const { asks, answer } = setup();
    asks.handle(question());
    asks.answerQuestion("q1", "yes");
    expect(answer.mock.calls).toEqual([["q1", { text: "yes" }]]);
    expect(asks.pending()).toEqual([]);
  });
  test("AC-17: mode changes apply to subsequent approvals", () => {
    const { asks, answer } = setup();
    const first = approval();
    asks.handle(first);
    asks.setMode("full");
    asks.handle(approval("r2"));
    expect(answer.mock.calls).toEqual([["r2", { decision: "allow" }]]);
    expect(asks.pending()).toEqual([first]);
  });
  test("AC-18: reset clears memory and all pending asks", () => {
    const { asks, answer } = setup();
    asks.handle(approval());
    asks.resolve("r1", "allow_session");
    asks.handle(question());
    asks.reset();
    expect(asks.pending()).toEqual([]);
    const next = approval("r2");
    asks.handle(next);
    expect(asks.pending()).toEqual([next]);
    expect(answer).toHaveBeenCalledTimes(1);
  });
  test("AC-19: each pending mutation notifies every subscriber once", () => {
    const { asks } = setup();
    const first = mock(() => {});
    const second = mock(() => {});
    asks.onChange(first);
    const unsubscribe = asks.onChange(second);
    const check = (count: number) => {
      expect(first).toHaveBeenCalledTimes(count);
      expect(second).toHaveBeenCalledTimes(count);
    };
    asks.handle(approval());
    check(1);
    asks.handle(question());
    check(2);
    asks.resolve("r1", "allow_once");
    check(3);
    asks.answerQuestion("q1", "yes");
    check(4);
    asks.handle(approval("r2"));
    check(5);
    asks.handle({ ...base, type: "approval_resolved", requestId: "r2", decision: "deny", decidedBy: "timeout" });
    check(6);
    asks.handle(question("q2"));
    check(7);
    asks.reset();
    check(8);
    asks.reset();
    check(8);
    unsubscribe();
    asks.handle(question("q3"));
    expect(first).toHaveBeenCalledTimes(9);
    expect(second).toHaveBeenCalledTimes(8);
  });
  test("ignores informational questions, unrelated events and stale or wrong-kind responses", () => {
    const { asks, answer } = setup();
    const listener = mock(() => {});
    asks.onChange(listener);
    asks.handle({ ...question(), answerable: false });
    asks.handle({ ...base, type: "turn_start" });
    asks.resolve("missing", "allow_session");
    asks.answerQuestion("missing", "yes");
    expect(listener).not.toHaveBeenCalled();
    asks.handle(question());
    asks.handle(approval());
    asks.resolve("q1", "allow_once");
    asks.answerQuestion("r1", "yes");
    expect(answer).not.toHaveBeenCalled();
    expect(asks.pending()).toEqual([question(), approval()]);
  });
  test("keeps positive memory across mode switches and supports non-execute tools", () => {
    const { asks, answer } = setup();
    const event = approval("r1", { tool: "Edit", command: undefined });
    expect(asks.canRemember(event)).toBe(true);
    asks.handle(event);
    asks.resolve("r1", "allow_session");
    asks.setMode("full");
    asks.setMode("guarded");
    asks.handle({ ...event, requestId: "r2" });
    expect(answer).toHaveBeenLastCalledWith("r2", { decision: "allow" });
    expect(asks.pending()).toEqual([]);
  });
});
