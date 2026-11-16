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
  turnEndEvent,
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

/**
 * A nested run that never settles while it is allowed to run, exposing the signal the chat
 * handed it. It still unwinds when that signal aborts — which is what a real `runSubagent`
 * does, and what the chat's close now waits for.
 */
function parkedRun(): () => AbortSignal | undefined {
  let captured: AbortSignal | undefined;
  _subagentRunsDeps.runSubagent = mock((input: RunSubagentInput) => {
    captured = input.signal;
    return unwindsOnAbort(input.signal);
  });
  return () => captured;
}

/** A run that resolves only once `signal` aborts, as a cancelled nested open does. */
function unwindsOnAbort(signal: AbortSignal | undefined): Promise<RunSubagentResult> {
  const cancelled: RunSubagentResult = { isError: true, content: "subagent reviewer cancelled: cancelled" };
  if (signal === undefined) return new Promise<RunSubagentResult>(() => {});
  if (signal.aborted) return Promise.resolve(cancelled);
  return new Promise<RunSubagentResult>((resolve) => {
    signal.addEventListener("abort", () => resolve(cancelled), { once: true });
  });
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

/** The session's cumulative spend as the host currently holds it. */
async function spent(h: SubagentHostHarness): Promise<number> {
  return h.host.current().meta.costUsd ?? 0;
}

/** A nested run whose completion — events and result — the test decides. */
function controlledRun(): { input(): RunSubagentInput | undefined; finish(costUsd: number): void } {
  const settled = Promise.withResolvers<RunSubagentResult>();
  let captured: RunSubagentInput | undefined;
  _subagentRunsDeps.runSubagent = mock((input: RunSubagentInput) => {
    captured = input;
    return settled.promise;
  });
  return {
    input: () => captured,
    finish: (costUsd: number) => {
      captured?.onEvent(turnEndEvent("bg done", costUsd));
      settled.resolve({ content: "bg done" });
    },
  };
}

describe("ChatHost background subagent runs", () => {
  withDepsRestore(_subagentRunsDeps);

  test("AC-20 the tool starts a background agent task and returns its id at once", async () => {
    parkedRun();
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    expect(h.toolResults[0]?.content).toStartWith("started in the background as agent-");
    const running = h.host.tasks?.running() ?? [];
    expect(running).toHaveLength(1);
    expect(running[0]?.kind).toBe("agent");
  });

  test("AC-21 the turn ending leaves the background run's signal unaborted", async () => {
    const signal = parkedRun();
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

describe("ChatHost background subagent spend", () => {
  withDepsRestore(_subagentRunsDeps);

  test.each([false, true])(
    "early background completion skips its starting turn and survives a failed next write: %s",
    async (failNextWrite) => {
      const h = setup({ holdChat: true, chatCostUsd: 1 });
      await h.host.start({ mode: "guarded", model: CHAT_MODEL });
      const run = controlledRun();
      const before = await spent(h);
      const starting = h.host.send("go", () => {});
      await waitForCondition(() => run.input() !== undefined);
      run.finish(0.25);
      h.releaseChat();
      await starting;
      expect((await spent(h)) - before).toBeCloseTo(1);

      h.control.skipRun = true;
      const write = h.storage.writeMeta.bind(h.storage);
      const attempted: number[] = [];
      h.storage.writeMeta = async (meta) => {
        attempted.push(meta.costUsd ?? 0);
        if (failNextWrite && attempted.length === 1) throw new Error("metadata write failed");
        return write(meta);
      };
      if (failNextWrite) {
        await expect(h.host.send("failed write", () => {})).rejects.toThrow("metadata write failed");
        expect((await spent(h)) - before).toBeCloseTo(1);
        expect((await h.storage.readMeta(h.host.current().meta.sessionId))?.costUsd).toBeCloseTo(before + 1);
      }
      await h.host.send("next persisted turn", () => {});
      expect(attempted).toEqual(failNextWrite ? [before + 2.25, before + 2.25] : [before + 2.25]);
      expect((await spent(h)) - before).toBeCloseTo(2.25);
      await h.host.send("one more", () => {});
      expect((await spent(h)) - before).toBeCloseTo(3.25);
    },
  );

  test("B1 background spend that lands during the metadata write reaches the next turn", async () => {
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const run = controlledRun();
    const before = await spent(h);
    const write = h.storage.writeMeta.bind(h.storage);
    let duringWrite: (() => void) | undefined;
    h.storage.writeMeta = async (meta) => {
      const during = duringWrite;
      duringWrite = undefined;
      // The spend is taken before the write, so finishing the run here lands after it.
      during?.();
      return write(meta);
    };
    duringWrite = () => run.finish(0.25);
    await h.host.send("go", () => {});
    h.control.skipRun = true;
    h.control.chatCostUsd = 1;
    await h.host.send("again", () => {});
    expect((await spent(h)) - before).toBeCloseTo(1.25);
  });

  test("B1 a send that threw does not discard background spend", async () => {
    const h = setup({ chatThrows: true, holdChat: true });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    const run = controlledRun();
    const before = await spent(h);
    const sending = h.host.send("go", () => {});
    await waitForCondition(() => run.input() !== undefined);
    // The background run finishes while the parent turn is still open: its spend is already
    // counted when the send throws and the turn's own accounting is released.
    run.finish(0.25);
    h.releaseChat();
    await expect(sending).rejects.toThrow("chat send failed");
    h.control.chatThrows = false;
    h.control.skipRun = true;
    h.control.chatCostUsd = 1;
    await h.host.send("again", () => {});
    expect((await spent(h)) - before).toBeCloseTo(1.25);
  });
});

describe("ChatHost background subagent teardown", () => {
  withDepsRestore(_subagentRunsDeps);

  test("B2 a stopped background run's open session is still closed by host.close", async () => {
    const h = setup({ holdNested: true, holdNestedPastCancel: true, holdNestedClose: true });
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    await waitForCondition(() => h.nestedSessions.length > 0);
    h.host.tasks?.stop(taskIdOf(h));
    let closed = false;
    const closing = h.host.close().then(() => {
      closed = true;
    });
    await waitForCondition(() => (h.nestedSessions[0]?.closeCalls ?? 0) >= 1);
    // The close waits on the session's own teardown, not on the stopped task's report.
    expect(closed).toBe(false);
    h.releaseNestedClose();
    await closing;
    expect(closed).toBe(true);
  });

  test("B2 host.close aborts a background run that has not opened its session yet", async () => {
    const signal = parkedRun();
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    await waitForCondition(() => signal() !== undefined);
    await h.host.close();
    expect(signal()?.aborted).toBe(true);
  });

  test("B2 host.close drains a pending open's cleanup before it releases the chat's resources", async () => {
    const cleanup = Promise.withResolvers<void>();
    const cleaningUp = Promise.withResolvers<void>();
    _subagentRunsDeps.runSubagent = mock(async (input: RunSubagentInput): Promise<RunSubagentResult> => {
      const signal = input.signal;
      if (signal === undefined) throw new Error("expected a run signal");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      cleaningUp.resolve();
      await cleanup.promise;
      return { isError: true, content: "subagent reviewer cancelled: cancelled" };
    });
    const h = setup();
    await h.host.start({ mode: "guarded", model: CHAT_MODEL });
    await h.host.send("go", () => {});
    let closed = false;
    const closing = h.host.close().then(() => {
      closed = true;
    });
    await cleaningUp.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The chat session — a resource the nested run's cleanup still touches — is not closed
    // while the drained run is unwinding.
    expect(closed).toBe(false);
    expect(h.chatSessions[0]?.closeCalls).toBe(0);
    cleanup.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(h.chatSessions[0]?.closeCalls).toBe(1);
  });
});
