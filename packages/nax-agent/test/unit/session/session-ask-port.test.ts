import { describe, expect, test } from "bun:test";
import type { SessionEventBody } from "@nathapp/nax-agent";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { assertNaxError, withDepsRestore } from "#test/helpers/index";

function setup(running = true) {
  const events: SessionEventBody[] = [];
  const table = createPendingAskTable(30_000);
  const controller = new AbortController();
  const port = createSessionAskPort({
    table,
    emit: (body) => events.push(body),
    turn: () => (running ? { turnId: "t1", signal: controller.signal } : undefined),
  });
  return { events, table, controller, port };
}

describe("createSessionAskPort", () => {
  withDepsRestore(_agentSessionDeps);

  test("requestApproval emits approval_requested and settles on answer()", async () => {
    const { events, table, port } = setup();
    const pending = port.requestApproval({
      callId: "c1",
      tool: "Write",
      summary: "write a.txt",
      reason: "ask profile",
    });
    const requested = events.find((e) => e.type === "approval_requested");
    expect(requested).toMatchObject({ callId: "c1", tool: "Write", summary: "write a.txt" });
    table.answer((requested as { requestId: string }).requestId, { decision: "allow" });
    expect(await pending).toEqual({ decision: "allow", decidedBy: "human" });
    expect(events.at(-1)).toMatchObject({ type: "approval_resolved", decision: "allow", decidedBy: "human" });
  });

  test("an extra abort signal cancels the approval", async () => {
    const { port } = setup();
    const extra = new AbortController();
    const pending = port.requestApproval({ tool: "Bash", summary: "s", reason: "r", signal: extra.signal });
    extra.abort();
    expect(await pending).toEqual({ decision: "deny", decidedBy: "cancelled" });
  });

  test("requestApproval with no running turn throws at once", async () => {
    const { port } = setup(false);
    let caught: unknown;
    try {
      await port.requestApproval({ tool: "Write", summary: "s", reason: "r" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_TURN_FAILED");
    expect(caught.context).toMatchObject({ detail: "no-turn" });
  });

  test("recordAutoDecision emits a requested/resolved pair decided by profile", () => {
    const { events, port } = setup();
    port.recordAutoDecision({ callId: "c2", tool: "edit", summary: "edit x", reason: "profile read" }, "deny");
    expect(events.map((e) => e.type)).toEqual(["approval_requested", "approval_resolved"]);
    expect(events[1]).toMatchObject({ decision: "deny", decidedBy: "profile" });
    expect((events[0] as { requestId: string }).requestId).toBe((events[1] as { requestId: string }).requestId);
  });

  test("askQuestion resolves with the text, and null on cancel", async () => {
    const { events, table, controller, port } = setup();
    const first = port.askQuestion("Which env?");
    const q = events.find((e) => e.type === "question") as { requestId: string };
    table.answer(q.requestId, { text: "staging" });
    expect(await first).toBe("staging");
    const second = port.askQuestion("Again?");
    controller.abort();
    expect(await second).toBeNull();
  });

  test("an extra abort signal settles the question cancelled at once (S4-5 D5-j)", async () => {
    const { events, table, port } = setup();
    const extra = new AbortController();
    const pending = port.askQuestion("Which env?", { signal: extra.signal });
    const q = events.find((e) => e.type === "question") as { requestId: string };
    extra.abort();
    expect(await pending).toBeNull();
    expect(table.answer(q.requestId, { text: "late" })).toBe("cancelled");
  });

  test("an already-aborted extra signal settles the question at once", async () => {
    const { port } = setup();
    expect(await port.askQuestion("Which env?", { signal: AbortSignal.abort() })).toBeNull();
  });

  test("noteQuestion emits a question whose answer is cancelled", () => {
    const { events, table, port } = setup();
    port.noteQuestion("declined: rich form");
    const q = events.find((e) => e.type === "question") as { requestId: string; text: string };
    expect(q.text).toBe("declined: rich form");
    expect(table.answer(q.requestId, { text: "x" })).toBe("cancelled");
  });

  test("recordAutoDecision, noteQuestion and askQuestion are inert with no running turn", async () => {
    const { events, port } = setup(false);
    port.recordAutoDecision({ tool: "t", summary: "s", reason: "r" }, "allow");
    port.noteQuestion("x");
    expect(await port.askQuestion("y")).toBeNull();
    expect(events).toEqual([]);
  });

  test("auto-decisions and noted questions are marked unanswerable (S5-2 M-1)", () => {
    const { events, port } = setup();
    port.recordAutoDecision({ callId: "c3", tool: "Write", summary: "write b", reason: "profile full" }, "allow");
    port.noteQuestion("FYI: the agent declined a form");
    expect(events[0]).toMatchObject({ type: "approval_requested", answerable: false });
    expect(events[1]).toMatchObject({ type: "approval_resolved", decidedBy: "profile" });
    expect(events[2]).toMatchObject({ type: "question", answerable: false });
  });

  test("a real approval and a real question carry no answerable marker", async () => {
    const { events, controller, port } = setup();
    const approval = port.requestApproval({ tool: "Write", summary: "s", reason: "r" });
    const question = port.askQuestion("Which env?");
    const asks = events.filter((e) => e.type === "approval_requested" || e.type === "question");
    expect(asks).toHaveLength(2);
    expect(asks.every((e) => !("answerable" in e))).toBe(true);
    controller.abort();
    await Promise.all([approval, question]);
  });
});
