import type { BackgroundTask } from "@/chat/background/task-types";

/** Fixed guidance for chat-owned Bash commands, not billed nax workflow jobs. */
export function buildBackgroundTasksInstructions(): string {
  return [
    "Use `Bash` with `runInBackground` to keep chatting while a command runs.",
    "Inspect background commands with `nax-tasks__list`, read their output with `nax-tasks__output`, and stop a command this chat started with `nax-tasks__stop` (no approval card).",
    "A [nax-tasks] notice arrives when a background command ends; read its output, report the outcome to the user and propose the next step.",
  ].join("\n");
}

/** Canonical coalesced completion notice; log paths are machine-local. */
export function buildBackgroundTaskNotice(tasks: readonly BackgroundTask[]): string {
  return [
    ...tasks.map(
      (task) =>
        `[nax-tasks] background command ${task.id} (${task.command}) ended: ${task.state}, exit code ${task.exitCode}, log ${task.logPath}`,
    ),
    "Read its output with `nax-tasks__output`, report the outcome to the user and propose the next step.",
  ].join("\n");
}
