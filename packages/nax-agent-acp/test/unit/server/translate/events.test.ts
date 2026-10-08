import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import type { ReadOldText } from "#src/server/translate/diff";
import { createEventTranslator, type EventTranslatorDeps } from "#src/server/translate/events";

const BASE = { sessionId: "s1", turnId: "t1", at: "2026-10-08T00:00:00.000Z", metadata: {} };
const ev = (body: SessionEventBody): SessionEvent => ({ ...BASE, ...body });
const noOld: ReadOldText = async () => ({ kind: "missing" });

const ALL_UPDATES = { notices: true, compaction: true };

function translator(contextWindow?: number, extra: Partial<EventTranslatorDeps> = {}) {
  return createEventTranslator({
    cwd: "/repo",
    readOldText: noOld,
    clientUpdates: ALL_UPDATES,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...extra,
  });
}

describe("streamed text", () => {
  test("text and thinking deltas become message and thought chunks", async () => {
    const t = translator();
    expect(await t.translate(ev({ type: "text_delta", round: 1, text: "hi" }))).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    ]);
    expect(await t.translate(ev({ type: "thinking_delta", round: 1, text: "hmm" }))).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    ]);
  });

  test("stream_reset is an info notice naming the attempt", async () => {
    expect(await translator().translate(ev({ type: "stream_reset", round: 1, attempt: 2 }))).toEqual([
      {
        sessionUpdate: "notice",
        severity: "info",
        title: "Response restarted",
        description: "The model stream was retried (attempt 2); text above may repeat.",
      },
    ]);
  });
});

describe("tool calls", () => {
  test("a call is in_progress with kind, title, locations, raw input and its diff", async () => {
    const input = { path: "src/a.ts", old_string: "a", new_string: "b" };
    expect(await translator().translate(ev({ type: "tool_call", callId: "c1", name: "Edit", input }))).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Edit src/a.ts",
        kind: "edit",
        status: "in_progress",
        rawInput: input,
        locations: [{ path: "/repo/src/a.ts" }],
        content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "a", newText: "b" }],
      },
    ]);
  });

  test("the result completes or fails the call and repeats the diff", async () => {
    const t = translator();
    await t.translate(ev({ type: "tool_call", callId: "c1", name: "Write", input: { path: "n.ts", content: "x" } }));
    expect(await t.translate(ev({ type: "tool_result", callId: "c1", isError: false, preview: "wrote" }))).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "wrote" } },
          { type: "diff", path: "/repo/n.ts", oldText: null, newText: "x" },
        ],
      },
    ]);
    await t.translate(ev({ type: "tool_call", callId: "c2", name: "Bash", input: { command: "false" } }));
    expect(await t.translate(ev({ type: "tool_result", callId: "c2", isError: true, preview: "exit 1" }))).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c2",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "exit 1" } }],
      },
    ]);
  });

  test("a result for a call never seen still yields a valid update", async () => {
    expect(
      await translator().translate(ev({ type: "tool_result", callId: "zz", isError: false, preview: "ok" })),
    ).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "zz",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      },
    ]);
  });

  test("malformed input: no diff, no locations, title is the name", async () => {
    const [update] = await translator().translate(ev({ type: "tool_call", callId: "c", name: "Edit", input: "?" }));
    expect(update).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "c",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
      rawInput: "?",
    });
  });

  test("toolCallFor returns the remembered call as pending, or undefined", async () => {
    const t = translator();
    await t.translate(ev({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "rm -rf build" } }));
    expect(t.toolCallFor("c1")).toEqual({
      toolCallId: "c1",
      title: "Bash: rm -rf build",
      kind: "execute",
      status: "pending",
      rawInput: { command: "rm -rf build" },
    });
    expect(t.toolCallFor("nope")).toBeUndefined();
  });
});

describe("approvals", () => {
  test("a profile deny fails the call with the reason; other resolutions emit nothing", async () => {
    const t = translator();
    const requested = (requestId: string) =>
      ev({
        type: "approval_requested",
        requestId,
        callId: "c1",
        tool: "Write",
        summary: "Write a.ts",
        reason: "read-only mode",
        expiresAt: BASE.at,
      });
    expect(await t.translate(requested("r1"))).toEqual([]);
    expect(
      await t.translate(ev({ type: "approval_resolved", requestId: "r1", decision: "deny", decidedBy: "profile" })),
    ).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "Denied by the session mode: read-only mode" } }],
      },
    ]);
    await t.translate(requested("r2"));
    expect(
      await t.translate(ev({ type: "approval_resolved", requestId: "r2", decision: "allow", decidedBy: "profile" })),
    ).toEqual([]);
    await t.translate(requested("r3"));
    expect(
      await t.translate(ev({ type: "approval_resolved", requestId: "r3", decision: "deny", decidedBy: "human" })),
    ).toEqual([]);
    expect(
      await t.translate(
        ev({ type: "approval_resolved", requestId: "unknown", decision: "deny", decidedBy: "profile" }),
      ),
    ).toEqual([]);
  });
});

describe("usage and compaction", () => {
  const usage = (extra: Partial<Extract<SessionEventBody, { type: "usage" }>> = {}) =>
    ev({
      type: "usage",
      round: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 30,
      cacheWrite: 5,
      costUsd: 0.01,
      ...extra,
    });

  test("usage_update counts every token kind against the context window (M-4)", async () => {
    expect(await translator(1000).translate(usage({ costSource: "computed" }))).toEqual([
      {
        sessionUpdate: "usage_update",
        used: 155,
        size: 1000,
        cost: { amount: 0.01, currency: "USD" },
        _meta: { naxAgent: { costSource: "computed" } },
      },
    ]);
  });

  test("unpriced rows carry no cost; an unknown window sends nothing", async () => {
    const [update] = await translator(1000).translate(usage({ costUsd: 0, costSource: "unpriced" }));
    expect(update).toMatchObject({ sessionUpdate: "usage_update", cost: null });
    expect(await translator().translate(usage())).toEqual([]);
  });

  test("each compaction gets its own id", async () => {
    const t = translator();
    const first = await t.translate(ev({ type: "compaction", reason: "proactive" }));
    const second = await t.translate(ev({ type: "compaction", reason: "overflow" }));
    expect(first).toEqual([
      {
        sessionUpdate: "compaction_update",
        compactionId: "t1-1",
        status: "completed",
        _meta: { naxAgent: { reason: "proactive" } },
      },
    ]);
    expect(second[0]).toMatchObject({ compactionId: "t1-2" });
  });
});

describe("events the session handles", () => {
  test.each<SessionEventBody>([
    { type: "turn_start" },
    { type: "question", requestId: "q", text: "?", expiresAt: BASE.at },
    { type: "turn_end", status: "completed", output: "", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 },
  ])("$type translates to nothing", async (body) => {
    expect(await translator().translate(ev(body))).toEqual([]);
  });
});

describe("client capability gating (review fix)", () => {
  test("without the notices capability, stream_reset becomes agent message text", async () => {
    const t = translator(undefined, { clientUpdates: { notices: false, compaction: true } });
    expect(await t.translate(ev({ type: "stream_reset", round: 1, attempt: 2 }))).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "\n\nResponse restarted: The model stream was retried (attempt 2); text above may repeat.\n\n",
        },
      },
    ]);
  });

  test("without the compaction capability, compaction sends nothing", async () => {
    const t = translator(undefined, { clientUpdates: { notices: true, compaction: false } });
    expect(await t.translate(ev({ type: "compaction", reason: "overflow" }))).toEqual([]);
  });
});

describe("cumulative session cost (review fix)", () => {
  const round = (costUsd: number, costSource?: "computed" | "unpriced") =>
    ev({ type: "usage", round: 1, inputTokens: 1, outputTokens: 1, costUsd, ...(costSource ? { costSource } : {}) });

  test("cost.amount is the running session total, starting from the prior cost", async () => {
    const t = translator(1000, { priorCostUsd: 1 });
    await t.translate(round(0.25));
    const [second] = await t.translate(round(0.5));
    expect(second).toMatchObject({ sessionUpdate: "usage_update", cost: { amount: 1.75, currency: "USD" } });
    expect(t.costUsd()).toBe(1.75);
  });

  test("an unpriced round adds nothing and reports no cost", async () => {
    const t = translator(1000);
    await t.translate(round(0.25));
    const [unpriced] = await t.translate(round(0, "unpriced"));
    expect(unpriced).toMatchObject({ cost: null });
    expect(t.costUsd()).toBe(0.25);
  });

  test("the total accrues even when no usage_update is sent (unknown window)", async () => {
    const t = translator();
    await t.translate(round(0.25));
    expect(t.costUsd()).toBe(0.25);
  });
});
