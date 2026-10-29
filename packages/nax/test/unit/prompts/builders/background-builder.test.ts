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
});
