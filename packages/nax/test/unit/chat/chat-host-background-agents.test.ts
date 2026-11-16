/**
 * US-007: the chat host's half of background subagent runs.
 *
 * Every test enters at the `nax-agents__run` tool of a provider the `ChatHost` built, so the
 * wiring under test is the host's own: the tool, the provider composition, the registry the
 * chat adopts into, and the ask controller a background run's requests land on.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import {
  approvalRequestedEvent,
  CHAT_MODEL,
  makeAgentResource,
  makeSubagentHostHarness,
  type SubagentHostHarness,
  type SubagentHostOptions,
  waitForCondition,
  withDepsRestore,
} from "@test/helpers";
import { _subagentRunsDeps } from "@/chat/subagent-runs";
import type { RunSubagentInput, RunSubagentResult } from "@/chat/subagent-session";

const reviewer = makeAgentResource({ name: "reviewer" });
/** What the scripted chat turn asks the tool for: a background run, not a foreground one. */
const BACKGROUND_INPUT = { agent: "reviewer", task: "check it", runInBackground: true };
let harness: SubagentHostHarness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

function setup(options: SubagentHostOptions = {}): SubagentHostHarness {
  harness = makeSubagentHostHarness({ agents: [reviewer], runInput: BACKGROUND_INPUT, ...options });
  return harness;
}

/** A nested run that never settles, exposing the signal the chat handed it. */
function hangingRun(): () => AbortSignal | undefined {
  let captured: AbortSignal | undefined;
  _subagentRunsDeps.runSubagent = mock((input: RunSubagentInput) => {
    captured = input.signal;
    return new Promise<RunSubagentResult>(() => {});
  });
  return () => captured;
}

/** The resolution a nested session emits for itself once the approval timeout elapses. */
function timeoutResolved(requestId: string): SessionEvent {
  return {
    sessionId: "scripted",
    turnId: "t",
    at: "2026-10-01T00:00:00.000Z",
    metadata: {},
    type: "approval_resolved",
    requestId,
    decision: "deny",
    decidedBy: "timeout",
  };
}

function taskIdOf(h: SubagentHostHarness): string {
  return (h.toolResults[0]?.content ?? "").replace("started in the background as ", "");
}

describe("ChatHost background subagent runs", () => {
  withDepsRestore(_subagentRunsDeps);

  test("AC-20 the tool starts a background agent task and returns its id at once", async () => {
    hangingRun();
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.toolResults[0]?.content).toStartWith("started in the background as agent-");
    const running = h.host.tasks?.running() ?? [];
    expect(running).toHaveLength(1);
    expect(running[0]?.kind).toBe("agent");
  });

  test("AC-21 the turn ending leaves the background run's signal unaborted", async () => {
    const signal = hangingRun();
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    await waitForCondition(() => signal() !== undefined);
    expect(signal()?.aborted).toBe(false);
  });
});

describe("ChatHost background subagent asks", () => {
  withDepsRestore(_subagentRunsDeps);

  test("AC-22 a background approval is pending with no parent turn running", async () => {
    const h = setup({ nestedEvents: [approvalRequestedEvent("n1", "edit file")], holdNested: true });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    await waitForCondition(() => h.host.asks.pending().some((ask) => ask.requestId === "n1"));
    expect(h.host.asks.pending().map((ask) => ask.requestId)).toContain("n1");
    h.releaseNested();
  });

  test("AC-23 an unanswered background approval ends as the configured approval timeout does today", async () => {
    const h = setup({
      nestedEvents: [approvalRequestedEvent("n1", "edit file")],
      nestedLateEvents: [timeoutResolved("n1")],
      holdNested: true,
    });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    await waitForCondition(() => h.host.asks.pending().some((ask) => ask.requestId === "n1"));
    expect(h.nestedSessionOptions[0]?.approvalTimeoutMs).toBe(h.config.execution.approvalTimeout);
    h.releaseNested();
    await waitForCondition(() => !h.host.asks.pending().some((ask) => ask.requestId === "n1"));
    expect(h.host.asks.pending().map((ask) => ask.requestId)).not.toContain("n1");
  });

  test("AC-24 a background subagent that throws writes its message to the task log", async () => {
    _subagentRunsDeps.runSubagent = mock(() => Promise.reject(new Error("boom")));
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    const id = taskIdOf(h);
    expect(id).toMatch(/^agent-[0-9a-f]{8}$/);
    await waitForCondition(() => h.host.tasks?.get(id)?.state === "failed");
    expect(await h.host.tasks?.output(id)).toContain("boom");
  });
});
