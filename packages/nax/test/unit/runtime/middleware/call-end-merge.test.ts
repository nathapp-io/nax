/** nax#2491 P7: the end of an agent call is one info line, not an agent-stream line plus a middleware line. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { AgentStreamEventBus } from "@/runtime/agent-stream-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachAgentStreamLogging } from "@/runtime/middleware/agent-stream-logging";
import { attachLoggingSubscriber } from "@/runtime/middleware/logging";

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "debug" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

const base = { runId: "r-1", agentName: "claude", sessionName: "sess-1", storyId: "s-1", stage: "run" as const };

function runCall(order: "stream-first" | "dispatch-first"): void {
  const stream = new AgentStreamEventBus();
  const dispatch = new DispatchEventBus();
  attachAgentStreamLogging(stream, "r-1");
  attachLoggingSubscriber(dispatch, "r-1");
  stream.emitAgentStream({
    ...base,
    kind: "agent.call_started",
    callId: "c1",
    pid: 1,
    timestamp: 1000,
    model: "model-a",
    timeoutSeconds: 60,
  });
  stream.emitAgentStream({ ...base, kind: "agent.message_update", callId: "c1", timestamp: 2000, deltaBytes: 10 });
  const ended = () =>
    stream.emitAgentStream({ ...base, kind: "agent.call_ended", callId: "c1", timestamp: 5000, status: "success" });
  const complete = () =>
    dispatch.emitDispatch({
      ...base,
      kind: "complete",
      sessionRole: "main",
      prompt: "p",
      response: "r",
      resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" },
      durationMs: 4000,
      timestamp: 5001,
    });
  if (order === "stream-first") {
    ended();
    complete();
  } else {
    complete();
    ended();
  }
}

const infoEnds = () =>
  logs.filter((e) => e.level === "info" && (e.message === "Agent call ended" || e.message === "Agent call complete"));

describe("agent call end lines", () => {
  test("one info line per call: the middleware line, carrying the stream's counters", () => {
    runCall("stream-first");
    const lines = infoEnds();
    expect(lines.map((e) => e.message)).toEqual(["Agent call complete"]);
    expect(lines[0]?.data).toMatchObject({ durationMs: 4000, status: "success", messageUpdates: 1, idleMs: 3000 });
  });

  test("the stream's own record is still in the log, at debug", () => {
    runCall("stream-first");
    expect(logs.find((e) => e.message === "Agent call ended")?.level).toBe("debug");
  });

  test("when the dispatch event lands first, the line is still single and just lacks the counters", () => {
    runCall("dispatch-first");
    const lines = infoEnds();
    expect(lines.map((e) => e.message)).toEqual(["Agent call complete"]);
    expect(lines[0]?.data).not.toHaveProperty("messageUpdates");
  });
});
