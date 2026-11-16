import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/chat/background";
import * as prompts from "@/prompts";

const { buildBackgroundTaskNotice, summarizeBackgroundNotice } = prompts;

function shell(id: string, state: BackgroundTask["state"]): BackgroundTask {
  return {
    id,
    command: "bun test",
    state,
    origin: "agent",
    startedAt: new Date(0).toISOString(),
    exitCode: state === "succeeded" ? 0 : 1,
    logPath: `/o/chat-tasks/${id}.log`,
  };
}

function agent(id: string, state: BackgroundTask["state"]): BackgroundTask {
  return {
    id,
    kind: "agent",
    command: "code-reviewer: Review the spec",
    state,
    origin: "agent",
    startedAt: new Date(0).toISOString(),
    logPath: `/o/chat-tasks/${id}.log`,
  };
}

describe("summarizeBackgroundNotice with agent tasks", () => {
  test("AC-16 one succeeded agent line counts background agents", () => {
    expect(summarizeBackgroundNotice(buildBackgroundTaskNotice([agent("agent-11111111", "succeeded")]))).toBe(
      "1 background agent ended · 1 succeeded",
    );
  });

  test("AC-17 an agent then a shell, both failed, counts background tasks", () => {
    const notice = buildBackgroundTaskNotice([agent("agent-11111111", "failed"), shell("bash-22222222", "failed")]);
    expect(notice.split("\n")[0]).toContain("background agent");
    expect(notice.split("\n")[1]).toContain("background command");
    expect(summarizeBackgroundNotice(notice)).toBe("2 background tasks ended · 2 failed");
  });

  test("AC-18 a succeeded shell then a failed agent counts background tasks with both states", () => {
    const notice = buildBackgroundTaskNotice([shell("bash-11111111", "succeeded"), agent("agent-22222222", "failed")]);
    expect(summarizeBackgroundNotice(notice)).toBe("2 background tasks ended · 1 succeeded · 1 failed");
  });

  test("AC-19 shell-only notices keep today's command wording", () => {
    expect(summarizeBackgroundNotice(buildBackgroundTaskNotice([shell("bash-11111111", "succeeded")]))).toBe(
      "1 background command ended · 1 succeeded",
    );
  });

  test("two agent lines use the plural agent noun", () => {
    const notice = buildBackgroundTaskNotice([agent("agent-11111111", "succeeded"), agent("agent-22222222", "failed")]);
    expect(summarizeBackgroundNotice(notice)).toBe("2 background agents ended · 1 succeeded · 1 failed");
  });
});
