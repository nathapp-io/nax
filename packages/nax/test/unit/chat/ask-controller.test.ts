import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AnswerReply, SessionEvent } from "@nathapp/nax-agent";
import { makeFakeClock } from "@test/helpers";
import * as chat from "@/chat";
import * as hostAsks from "@/chat/ask-controller";

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

describe("host questions (US-009)", () => {
  const original = { ...hostAsks._askControllerDeps };
  const now = new Date("2026-10-27T00:00:00.000Z");
  const timeout = 200;
  let clock: ReturnType<typeof makeFakeClock>;
  beforeEach(() => {
    clock = makeFakeClock();
    hostAsks._askControllerDeps.setTimeout = clock.setTimeout;
    hostAsks._askControllerDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  });
  afterEach(() => Object.assign(hostAsks._askControllerDeps, original));
  function hostSetup() {
    const answer = mock((_id: string, _reply: AnswerReply) => {});
    const asks = chat.createChatAskController({ mode: "full", answer, approvalTimeoutMs: timeout, now: () => now });
    return { asks, answer };
  }
  test("AC-1/2/3/4: queues a host question and answers locally", async () => {
    const { asks, answer } = hostSetup();
    const result = asks.requestHostQuestion({ text: "Which base branch?" });
    expect(asks.pending()).toHaveLength(1);
    const event = asks.pending()[0];
    expect(event).toMatchObject({
      type: "question",
      text: "Which base branch?",
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + timeout).toISOString(),
    });
    expect(event?.requestId.startsWith("host-question-")).toBe(true);
    const id = event?.requestId ?? "missing";
    asks.handle({ ...base, type: "approval_resolved", requestId: id, decision: "deny", decidedBy: "timeout" });
    expect(asks.pending()).toEqual([event]);
    asks.answerQuestion(id, "main");
    expect(await result).toBe("main");
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
    asks.answerQuestion(id, "stale");
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-5/6: abort settles null and removes the question", async () => {
    const { asks, answer } = hostSetup();
    const abort = new AbortController();
    const result = asks.requestHostQuestion({ text: "Which base branch?", signal: abort.signal });
    expect(asks.pending()).toHaveLength(1);
    abort.abort();
    expect(await result).toBeNull();
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-7: pre-aborted signal creates no entry or timer", async () => {
    const { asks } = hostSetup();
    const abort = new AbortController();
    abort.abort();
    const changed = mock(() => {});
    asks.onChange(changed);
    expect(await asks.requestHostQuestion({ text: "Which base branch?", signal: abort.signal })).toBeNull();
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });
  test("AC-8: configured timeout settles null", async () => {
    const { asks, answer } = hostSetup();
    const result = asks.requestHostQuestion({ text: "Which base branch?" });
    await clock.advance(timeout - 1);
    expect(asks.pending()).toHaveLength(1);
    await clock.advance(2);
    expect(await result).toBeNull();
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-9: reset settles all host questions", async () => {
    const { asks, answer } = hostSetup();
    const results = [asks.requestHostQuestion({ text: "First?" }), asks.requestHostQuestion({ text: "Second?" })];
    expect(new Set(asks.pending().map((ask) => ask.requestId)).size).toBe(2);
    asks.reset();
    expect(await Promise.all(results)).toEqual([null, null]);
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });
  test.each(["answer", "abort", "timeout", "reset"] as const)(
    "%s removes the abort listener and notifies once",
    async (settlement) => {
      const { asks, answer } = hostSetup();
      const abort = new AbortController();
      const remove = mock(abort.signal.removeEventListener.bind(abort.signal));
      abort.signal.removeEventListener = remove;
      const changed = mock(() => {});
      asks.onChange(changed);
      const result = asks.requestHostQuestion({ text: "Branch?", signal: abort.signal });
      const id = asks.pending()[0]?.requestId ?? "missing";
      if (settlement === "answer") asks.answerQuestion(id, "");
      else if (settlement === "abort") abort.abort();
      else if (settlement === "timeout") await clock.advance(timeout);
      else asks.reset();
      expect(await result).toBe(settlement === "answer" ? "" : null);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(clock.pending()).toBe(0);
      expect(asks.pending()).toEqual([]);
      abort.abort();
      asks.answerQuestion(id, "late");
      asks.reset();
      expect(changed).toHaveBeenCalledTimes(2);
      expect(answer).not.toHaveBeenCalled();
    },
  );
  test("AC-10: session questions still forward text", () => {
    const { asks, answer } = hostSetup();
    asks.handle(question("session-question"));
    asks.answerQuestion("session-question", "main");
    expect(answer.mock.calls).toEqual([["session-question", { text: "main" }]]);
    expect(asks.pending()).toEqual([]);
  });
});

describe("host approvals (US-008)", () => {
  const original = { ...hostAsks._askControllerDeps };
  const card = { tool: "nax-jobs__run", summary: "nax run f1", command: "c", reason: "r" };
  const now = new Date("2026-10-27T00:00:00.000Z");
  const timeout = 2_000;
  let clock: ReturnType<typeof makeFakeClock>;
  beforeEach(() => {
    clock = makeFakeClock();
    hostAsks._askControllerDeps.setTimeout = clock.setTimeout;
    hostAsks._askControllerDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  });
  afterEach(() => Object.assign(hostAsks._askControllerDeps, original));
  function hostSetup(approvalTimeoutMs: number | undefined = timeout) {
    const answer = mock((_id: string, _reply: AnswerReply) => {});
    const asks = hostAsks.createChatAskController({ mode: "full", answer, now: () => now, approvalTimeoutMs });
    return { asks, answer };
  }
  test("AC-1 through AC-5, AC-11: full-mode host card carries fields and expiry and never auto-answers", async () => {
    const { asks, answer } = hostSetup();
    const result = asks.requestHostApproval(card);
    expect(asks.pending()).toHaveLength(1);
    const event = asks.pending()[0];
    expect(event?.requestId.startsWith("host-")).toBe(true);
    expect(event).toMatchObject({
      ...card,
      type: "approval_requested",
      expiresAt: new Date(now.getTime() + timeout).toISOString(),
    });
    if (event?.type !== "approval_requested") throw new Error("missing host approval");
    expect(asks.canRemember(event)).toBe(false);
    asks.handle(event);
    expect(asks.pending()).toEqual([event]);
    expect(answer).not.toHaveBeenCalled();
    asks.reset();
    expect(await result).toBe("deny");
  });
  test.each([
    ["allow_once", "allow"],
    ["deny", "deny"],
    ["allow_session", "allow"],
  ] as const)("AC-6 through AC-10: %s resolves %s only to the host and cleans up", async (choice, decision) => {
    const { asks, answer } = hostSetup();
    const result = asks.requestHostApproval(card);
    const id = asks.pending()[0]?.requestId ?? "missing";
    const changed = mock(() => {});
    asks.onChange(changed);
    asks.resolve(id, choice);
    expect(await result).toBe(decision);
    expect(answer).not.toHaveBeenCalled();
    expect(asks.pending()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
    asks.resolve(id, "deny");
    expect(changed).toHaveBeenCalledTimes(1);
  });
  test("AC-12: allow_session never remembers even a rememberable host tool", async () => {
    const { asks, answer } = hostSetup();
    asks.setMode("guarded");
    const rememberable = { ...card, tool: "Bash", command: "npm test" };
    const first = asks.requestHostApproval(rememberable);
    const event = asks.pending()[0];
    if (event?.type !== "approval_requested") throw new Error("missing host approval");
    expect(asks.canRemember(event)).toBe(false);
    asks.resolve(asks.pending()[0]?.requestId ?? "missing", "allow_session");
    expect(await first).toBe("allow");
    const second = asks.requestHostApproval(rememberable);
    expect(asks.pending()).toHaveLength(1);
    asks.handle(approval());
    expect(asks.pending()).toHaveLength(2);
    expect(answer).not.toHaveBeenCalled();
    asks.reset();
    expect(await second).toBe("deny");
  });
  test("AC-13: expiry fails closed at precisely the timeout and notifies", async () => {
    const { asks } = hostSetup();
    const result = asks.requestHostApproval(card);
    const changed = mock(() => {});
    asks.onChange(changed);
    await clock.advance(timeout - 1);
    expect(asks.pending()).toHaveLength(1);
    await clock.advance(1);
    expect(await result).toBe("deny");
    expect(asks.pending()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });
  test.each([false, true])("AC-14, AC-15: abort fails closed (already aborted: %s)", async (already) => {
    const { asks, answer } = hostSetup();
    const abort = new AbortController();
    if (already) abort.abort();
    const result = asks.requestHostApproval({ ...card, signal: abort.signal });
    const changed = mock(() => {});
    asks.onChange(changed);
    abort.abort();
    expect(await result).toBe("deny");
    expect(asks.pending()).toEqual([]);
    expect(answer).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    if (!already) expect(changed).toHaveBeenCalledTimes(1);
  });
  test("AC-16: reset denies all host promises and cancels every timer", async () => {
    const { asks, answer } = hostSetup();
    const results = [asks.requestHostApproval(card), asks.requestHostApproval(card)];
    expect(new Set(asks.pending().map((event) => event.requestId)).size).toBe(2);
    asks.reset();
    expect(await Promise.all(results)).toEqual(["deny", "deny"]);
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-17: omitted timeout defaults to ten minutes", async () => {
    const asks = hostAsks.createChatAskController({ mode: "guarded", answer: () => {}, now: () => now });
    const result = asks.requestHostApproval(card);
    expect(hostAsks.DEFAULT_HOST_APPROVAL_TIMEOUT_MS).toBe(600_000);
    expect(asks.pending()[0]?.expiresAt).toBe(new Date(now.getTime() + 600_000).toISOString());
    asks.reset();
    expect(await result).toBe("deny");
  });
});

describe("host choices (US-012)", () => {
  const original = { ...hostAsks._askControllerDeps };
  const card = {
    tool: "nax-close",
    summary: "Quit?",
    reason: "Tasks are running",
    choices: [
      { id: "stop", label: "Quit and stop them" },
      { id: "stay", label: "Stay in chat" },
    ],
    fallback: "stay",
  };
  let clock: ReturnType<typeof makeFakeClock>;
  beforeEach(() => {
    clock = makeFakeClock();
    hostAsks._askControllerDeps.setTimeout = clock.setTimeout;
    hostAsks._askControllerDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  });
  afterEach(() => Object.assign(hostAsks._askControllerDeps, original));
  test("AC-1/2/3: queues a host choice with ids, fallback and expiry", async () => {
    const { asks, answer } = setup("full");
    const result = asks.requestHostChoice(card);
    expect(asks.pending()).toHaveLength(1);
    expect(asks.pending()[0]).toMatchObject({ ...card, type: "host_choice" });
    expect(asks.pending()[0]?.requestId.startsWith("host-choice-")).toBe(true);
    expect(Number.isFinite(Date.parse(asks.pending()[0]?.expiresAt ?? ""))).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    asks.reset();
    expect(await result).toBe("stay");
  });
  test("AC-4/5: resolves an id, removes the ask and cancels its timer", async () => {
    const { asks, answer } = setup();
    const result = asks.requestHostChoice(card);
    const id = asks.pending()[0]?.requestId ?? "missing";
    const changed = mock(() => {});
    asks.onChange(changed);
    asks.resolveChoice(id, "stop");
    expect(await result).toBe("stop");
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(changed).toHaveBeenCalledTimes(1);
    asks.resolveChoice(id, "stay");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(answer).not.toHaveBeenCalled();
  });
  test("choice ids reject invalid and wrong-kind answers and ignore session resolutions", async () => {
    const { asks, answer } = setup();
    const abort = new AbortController();
    const result = asks.requestHostChoice({ ...card, signal: abort.signal });
    const id = asks.pending()[0]?.requestId ?? "missing";
    const changed = mock(() => {});
    asks.onChange(changed);
    asks.resolveChoice("missing", "stop");
    asks.resolveChoice(id, "unknown");
    asks.resolve(id, "allow_once");
    asks.answerQuestion(id, "stop");
    asks.handle({ ...base, type: "approval_resolved", requestId: id, decision: "allow", decidedBy: "timeout" });
    expect(asks.pending()).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    asks.resolveChoice(id, "stop");
    abort.abort();
    expect(await result).toBe("stop");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-6: timeout returns the fallback at the configured deadline", async () => {
    const asks = chat.createChatAskController({ mode: "full", answer: () => {}, approvalTimeoutMs: 200 });
    const result = asks.requestHostChoice(card);
    await clock.advance(199);
    expect(asks.pending()).toHaveLength(1);
    await clock.advance(1);
    expect(await result).toBe("stay");
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
  test.each([false, true])("AC-7: abort returns fallback (already aborted: %s)", async (already) => {
    const { asks } = setup();
    const abort = new AbortController();
    if (already) abort.abort();
    const result = asks.requestHostChoice({ ...card, signal: abort.signal });
    abort.abort();
    expect(await result).toBe("stay");
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
  test("AC-8/13: reset settles each fallback independently of host approvals", async () => {
    const { asks } = setup();
    const first = asks.requestHostChoice(card);
    const second = asks.requestHostChoice({ ...card, fallback: "stop" });
    const approval = asks.requestHostApproval({ tool: "Bash", summary: "Run", reason: "r" });
    const id = asks.pending().find((ask) => ask.type === "approval_requested")?.requestId ?? "missing";
    asks.resolve(id, "allow_once");
    expect(await approval).toBe("allow");
    expect(asks.pending()).toHaveLength(2);
    asks.reset();
    expect(await Promise.all([first, second])).toEqual(["stay", "stop"]);
    expect(asks.pending()).toEqual([]);
    expect(clock.pending()).toBe(0);
  });
});
