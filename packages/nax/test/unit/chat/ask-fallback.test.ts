import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AnswerReply, SessionEvent } from "@nathapp/nax-agent";
import { makeFakeClock, makeInteractionChain, makeLogger } from "@test/helpers";
import { createChatAskController } from "@/chat/ask-controller";
import { _askFallbackDeps, createAskFallback } from "@/chat/ask-fallback";
import type { InteractionResponse } from "@/interaction/types";

const DELAY = 1_000;
const base = { sessionId: "s1", turnId: "t1", at: "2026-10-20T00:00:00Z", metadata: {} };
function approval(
  overrides: Partial<Extract<SessionEvent, { type: "approval_requested" }>> = {},
): Extract<SessionEvent, { type: "approval_requested" }> {
  return {
    ...base,
    type: "approval_requested",
    requestId: "r1",
    tool: "Bash",
    command: "echo [REDACTED:token]",
    summary: "Run command",
    reason: "Needs approval",
    expiresAt: "2026-10-20T01:00:00Z",
    ...overrides,
  };
}
function resolved(): Extract<SessionEvent, { type: "approval_resolved" }> {
  return { ...base, type: "approval_resolved", requestId: "r1", decision: "deny", decidedBy: "timeout" };
}

describe("createAskFallback", () => {
  const original = { ..._askFallbackDeps };
  let clock: ReturnType<typeof makeFakeClock>;
  let fallback: ReturnType<typeof createAskFallback> | undefined;
  beforeEach(() => {
    clock = makeFakeClock();
    _askFallbackDeps.setTimeout = clock.setTimeout;
    _askFallbackDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  });
  afterEach(() => {
    fallback?.dispose();
    fallback = undefined;
    Object.assign(_askFallbackDeps, original);
  });
  function setup(noChain = false) {
    const answer = mock((_id: string, _reply: AnswerReply) => {});
    const controller = createChatAskController({ mode: "guarded", answer });
    const response = Promise.withResolvers<InteractionResponse>();
    const prompt = mock((_request: unknown) => response.promise);
    const cancel = mock(async (_id: string) => {});
    const chain = makeInteractionChain({ prompt, cancel });
    const logger = makeLogger();
    fallback = createAskFallback({ controller, chain: noChain ? null : chain, delayMs: DELAY, logger });
    controller.handle(approval());
    return { controller, answer, response, prompt, cancel, logger };
  }
  test("AC-1: waits for the complete delay", async () => {
    const { prompt } = setup();
    await clock.advance(DELAY - 1);
    expect(prompt).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(1);
  });
  test("AC-2, AC-3, AC-4: offers one correctly shaped masked approval", async () => {
    const { prompt } = setup();
    await clock.advance(DELAY);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith({
      id: "chat-r1",
      type: "confirm",
      featureName: "chat",
      stage: "custom",
      summary: "Run command",
      detail: "echo [REDACTED:token]\nNeeds approval",
      fallback: "skip",
      createdAt: expect.any(Number),
    });
    await clock.advance(DELAY * 2);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
  test.each([
    ["AC-5", "approve", "allow"],
    ["AC-6", "reject", "deny"],
    ["abort", "abort", "deny"],
  ] as const)("%s: maps %s to %s", async (_ac, action, decision) => {
    const { response, answer, controller } = setup();
    await clock.advance(DELAY);
    response.resolve({ requestId: "chat-r1", action, respondedAt: clock.now() });
    await clock.advance(0);
    expect(answer.mock.calls).toEqual([["r1", { decision }]]);
    expect(controller.pending()).toEqual([]);
  });
  test.each(["skip", "choose", "input"] as const)("AC-7: ignores %s and does not reoffer", async (action) => {
    const { response, answer, controller, prompt } = setup();
    await clock.advance(DELAY);
    response.resolve({ requestId: "chat-r1", action, respondedAt: clock.now() });
    await clock.advance(DELAY * 3);
    expect(answer).not.toHaveBeenCalled();
    expect(controller.pending()).toHaveLength(1);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
  test("AC-8: ignores a late response", async () => {
    const { response, answer, controller } = setup();
    await clock.advance(DELAY);
    controller.handle(resolved());
    response.resolve({ requestId: "chat-r1", action: "approve", respondedAt: clock.now() });
    await clock.advance(0);
    expect(answer).not.toHaveBeenCalled();
    expect(controller.pending()).toEqual([]);
  });
  test("AC-9: terminal answer before expiry clears the timer", async () => {
    const { controller, prompt, cancel } = setup();
    controller.resolve("r1", "allow_once");
    expect(clock.pending()).toBe(0);
    await clock.advance(DELAY * 2);
    expect(prompt).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
  test.each(["terminal", "event"] as const)("AC-10, AC-11: %s resolution cancels once", async (via) => {
    const { controller, cancel } = setup();
    await clock.advance(DELAY);
    if (via === "terminal") controller.resolve("r1", "deny");
    else controller.handle(resolved());
    controller.handle(resolved());
    expect(cancel.mock.calls).toEqual([["chat-r1"]]);
  });
  test("AC-12: rejected prompt logs only the extracted error", async () => {
    const { response, logger, controller, answer } = setup();
    await clock.advance(DELAY);
    response.reject(Object.assign(new Error("offline"), { secret: "must not log" }));
    await clock.advance(0);
    expect(logger.calls).toEqual([
      { level: "warn", stage: "chat", message: "chat ask fallback failed", data: { error: "offline" } },
    ]);
    expect(controller.pending()).toHaveLength(1);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-13, AC-19: no chain leaves session timeout in charge", async () => {
    const { controller, answer, prompt } = setup(true);
    await clock.advance(DELAY * 2);
    expect(controller.pending()).toHaveLength(1);
    expect(answer).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    clock.setTimeout(() => controller.handle(resolved()), DELAY);
    await clock.advance(DELAY - 1);
    expect(controller.pending()).toHaveLength(1);
    await clock.advance(1);
    expect(controller.pending()).toEqual([]);
    expect(answer).not.toHaveBeenCalled();
  });
  test("AC-14: questions are not offered", async () => {
    const { controller, prompt } = setup();
    controller.reset();
    controller.handle({ ...base, type: "question", requestId: "q1", text: "Why?", expiresAt: "2026-10-20T01:00:00Z" });
    await clock.advance(DELAY * 2);
    expect(prompt).not.toHaveBeenCalled();
    expect(controller.pending()).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });
  test("AC-15: dispose clears timers and unsubscribes", async () => {
    const { controller, prompt } = setup();
    fallback?.dispose();
    expect(clock.pending()).toBe(0);
    controller.handle(approval({ requestId: "r2" }));
    await clock.advance(DELAY * 2);
    expect(prompt).not.toHaveBeenCalled();
  });
  test("omits absent command and schedules existing pending approvals", async () => {
    const { controller, prompt } = setup();
    fallback?.dispose();
    controller.reset();
    controller.handle(approval({ command: undefined }));
    const chain = makeInteractionChain({ prompt });
    fallback = createAskFallback({ controller, chain, delayMs: DELAY, logger: makeLogger() });
    await clock.advance(DELAY);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ detail: "Needs approval" }));
  });
});
