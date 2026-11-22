/** The bounded per-task event record behind the agent view. */

import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import {
  textDeltaEvent,
  toolCallEvent,
  toolResultEvent,
  turnEndEvent,
  turnStartEvent,
  usageEvent,
} from "@test/helpers";
import { createTaskEventLog, TASK_EVENTS_MAX_BYTES, TASK_EVENTS_MAX_ENTRIES } from "@/chat/background";

function thinking(text: string, round = 1): SessionEvent {
  const { sessionId, turnId, at, metadata } = turnStartEvent();
  return { sessionId, turnId, at, metadata, type: "thinking_delta", round, text };
}

describe("createTaskEventLog", () => {
  test("keeps the events a transcript is built from and ignores the rest", () => {
    const log = createTaskEventLog();
    for (const event of [
      turnStartEvent(),
      usageEvent(),
      toolCallEvent("c1"),
      toolResultEvent("c1"),
      turnEndEvent("x"),
    ]) {
      log.append(event);
    }
    expect(log.snapshot().map((event) => event.type)).toEqual(["tool_call", "tool_result", "turn_end"]);
  });

  test("folds consecutive text deltas of one round into one event", () => {
    const log = createTaskEventLog();
    log.append(textDeltaEvent("he"));
    log.append(textDeltaEvent("llo"));
    const events = log.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text_delta", text: "hello" });
  });

  test("does not fold across a tool call or across thinking and text", () => {
    const log = createTaskEventLog();
    log.append(thinking("a"));
    log.append(textDeltaEvent("b"));
    log.append(toolCallEvent("c1"));
    log.append(textDeltaEvent("c"));
    expect(log.snapshot().map((event) => event.type)).toEqual([
      "thinking_delta",
      "text_delta",
      "tool_call",
      "text_delta",
    ]);
  });

  test("does not fold deltas of different rounds", () => {
    const log = createTaskEventLog();
    log.append(thinking("a", 1));
    log.append(thinking("b", 2));
    expect(log.snapshot()).toHaveLength(2);
  });

  test("drops the oldest events past the entry cap", () => {
    const log = createTaskEventLog();
    for (let index = 0; index < TASK_EVENTS_MAX_ENTRIES + 10; index += 1) log.append(toolCallEvent(`c${index}`));
    const events = log.snapshot();
    expect(events).toHaveLength(TASK_EVENTS_MAX_ENTRIES);
    expect(events[0]).toMatchObject({ callId: "c10" });
    expect(events.at(-1)).toMatchObject({ callId: `c${TASK_EVENTS_MAX_ENTRIES + 9}` });
  });

  test("drops the oldest events past the byte cap, keeping the newest", () => {
    const log = createTaskEventLog();
    const chunk = "x".repeat(TASK_EVENTS_MAX_BYTES / 8);
    for (let index = 0; index < 8; index += 1) log.append(toolResultEvent(`c${index}`));
    for (let index = 0; index < 6; index += 1) {
      log.append({ ...toolResultEvent(`big${index}`), preview: chunk });
    }
    const ids = log.snapshot().map((event) => (event.type === "tool_result" ? event.callId : ""));
    expect(ids.at(-1)).toBe("big5");
    expect(ids).not.toContain("c0");
    expect(ids.length).toBeLessThan(14);
  });

  test("a single run longer than the byte cap keeps only its newest text", () => {
    const log = createTaskEventLog();
    log.append(textDeltaEvent("a".repeat(TASK_EVENTS_MAX_BYTES)));
    log.append(textDeltaEvent("tail"));
    const [event] = log.snapshot();
    // Two bytes per UTF-16 code unit: the cap is real heap, not characters.
    expect(event?.type === "text_delta" ? event.text.length : 0).toBe(TASK_EVENTS_MAX_BYTES / 2);
    expect(event?.type === "text_delta" ? event.text.endsWith("tail") : false).toBe(true);
  });

  test("size() reports entries and estimated bytes at two bytes per character", () => {
    const log = createTaskEventLog();
    log.append(textDeltaEvent("abcd"));
    const first = log.size();
    log.append(textDeltaEvent("abcd"));
    expect(first.entries).toBe(1);
    expect(log.size()).toEqual({ entries: 1, bytes: first.bytes + 8 });
  });

  test("evict() empties the log, reports it and ignores later appends", () => {
    const log = createTaskEventLog();
    log.append(toolCallEvent("c1"));
    log.evict();
    log.append(toolCallEvent("c2"));
    expect(log.snapshot()).toEqual([]);
    expect(log.evicted()).toBe(true);
    expect(log.size()).toEqual({ entries: 0, bytes: 0 });
  });

  test("a snapshot is a copy and clear() empties the log", () => {
    const log = createTaskEventLog();
    log.append(toolCallEvent("c1"));
    const before = log.snapshot();
    log.append(toolCallEvent("c2"));
    expect(before).toHaveLength(1);
    log.clear();
    expect(log.snapshot()).toEqual([]);
  });
});
