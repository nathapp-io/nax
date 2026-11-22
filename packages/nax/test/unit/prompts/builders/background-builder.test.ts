import { describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/chat/background";
import * as prompts from "@/prompts";

const task: BackgroundTask = {
  id: "bash-1a2b3c4d",
  command: "bun test",
  state: "failed",
  origin: "agent",
  startedAt: new Date(0).toISOString(),
  exitCode: 1,
  logPath: "/o/chat-tasks/bash-1a2b3c4d.log",
};
describe("buildBackgroundTaskNotice", () => {
  test("AC-9 describes failed command and directs follow-up", () => {
    expect(prompts.buildBackgroundTaskNotice([task])).toBe(
      "[nax-tasks] background command bash-1a2b3c4d (bun test) ended: failed, exit code 1, log /o/chat-tasks/bash-1a2b3c4d.log\nRead its output with `nax-tasks__output`, report the outcome to the user and propose the next step.",
    );
  });
  test("coalesces commands with one follow-up instruction", () => {
    const text = prompts.buildBackgroundTaskNotice([
      task,
      { ...task, id: "bash-00000000", state: "succeeded", exitCode: 0 },
    ]);
    expect(text.split("\n")).toHaveLength(3);
    expect(text.split("\n")[1]).toContain("bash-00000000 (bun test) ended: succeeded, exit code 0");
  });
});
describe("buildBackgroundTasksInstructions", () => {
  test("AC-10 names Bash background flag, inspection tools and completion notices", () => {
    const text = prompts.buildBackgroundTasksInstructions();
    for (const name of [
      "Bash",
      "runInBackground",
      "nax-tasks__list",
      "nax-tasks__output",
      "nax-tasks__stop",
      "[nax-tasks]",
    ])
      expect(text).toContain(name);
    expect(text).toContain("when a background command ends");
  });

  test("AC-15 offers a background subagent run and what happens to it", () => {
    const text = prompts.buildBackgroundTasksInstructions();
    expect(text).toContain("nax-agents__run");
    expect(text).toContain("runInBackground");
    expect(text).toContain("keeps running after your turn ends");
    expect(text).toContain("starts in the background unless you pass `runInBackground: false`");
  });
});

describe("buildBackgroundTaskNotice with agent tasks (US-005)", () => {
  const agentTask: BackgroundTask = {
    id: "agent-1a2b3c4d",
    kind: "agent",
    command: "code-reviewer: Review the spec",
    state: "failed",
    origin: "agent",
    startedAt: new Date(0).toISOString(),
    logPath: "/o/chat-tasks/agent-1a2b3c4d.log",
  };

  test("AC-14 keeps the shell line, then writes the agent line, then one follow-up", () => {
    const lines = prompts.buildBackgroundTaskNotice([task, agentTask]).split("\n");
    expect(lines).toEqual([
      "[nax-tasks] background command bash-1a2b3c4d (bun test) ended: failed, exit code 1, log /o/chat-tasks/bash-1a2b3c4d.log",
      "[nax-tasks] background agent agent-1a2b3c4d (code-reviewer: Review the spec) ended: failed, log /o/chat-tasks/agent-1a2b3c4d.log",
      "Read its output with `nax-tasks__output`, report the outcome to the user and propose the next step.",
    ]);
  });
});
