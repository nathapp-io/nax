import type { BackgroundTask } from "@/chat/background/task-types";

/** Fixed guidance for chat-owned Bash commands, not billed nax workflow jobs. */
export function buildBackgroundTasksInstructions(): string {
  return [
    "Use `Bash` with `runInBackground` to keep chatting while a command runs.",
    "Inspect background commands with `nax-tasks__list`, read their output with `nax-tasks__output`, and stop a command this chat started with `nax-tasks__stop` (no approval card).",
    "A `nax-agents__run` call starts in the background unless you pass `runInBackground: false`: it keeps running after your turn ends, it is listed and stopped like a background command, and a [nax-tasks] notice arrives when it ends.",
    "A [nax-tasks] notice arrives when a background command ends; read its output, report the outcome to the user and propose the next step.",
  ].join("\n");
}

/** One task's notice line: an agent run has no exit code, so it states only where its log is. */
function taskNoticeLine(task: BackgroundTask): string {
  if (task.kind === "agent") {
    return `[nax-tasks] background agent ${task.id} (${task.command}) ended: ${task.state}, log ${task.logPath}`;
  }
  return `[nax-tasks] background command ${task.id} (${task.command}) ended: ${task.state}, exit code ${task.exitCode}, log ${task.logPath}`;
}

/** Canonical coalesced completion notice; log paths are machine-local. */
export function buildBackgroundTaskNotice(tasks: readonly BackgroundTask[]): string {
  return [
    ...tasks.map(taskNoticeLine),
    "Read its output with `nax-tasks__output`, report the outcome to the user and propose the next step.",
  ].join("\n");
}
