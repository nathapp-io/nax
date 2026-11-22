export { createHostTasks } from "./host-tasks";
export {
  createShellTail,
  SHELL_TAIL_MAX_BYTES,
  SHELL_TAIL_MAX_LINES,
  SHELL_TAIL_REFRESH_MS,
} from "./shell-tail";
export {
  createShellTails,
  SHELL_TAIL_TOTAL_MAX_BYTES,
  type ShellTails,
  type ShellTailsOptions,
} from "./shell-tails";
export {
  createTaskEventLog,
  TASK_EVENTS_MAX_BYTES,
  TASK_EVENTS_MAX_ENTRIES,
  TASK_EVENTS_TOTAL_MAX_BYTES,
  TASK_EVENTS_TOTAL_MAX_ENTRIES,
  type TaskEventLog,
} from "./task-events";
export {
  _backgroundTaskDeps,
  createBackgroundTasks,
  TASK_LOG_MAX_BYTES,
  TASK_LOG_TAIL_BYTES,
  TASK_OUTPUT_MAX_LINES,
} from "./task-registry";
export type {
  BackgroundAgentEnd,
  BackgroundAgentHandle,
  BackgroundAgentOutcome,
  BackgroundAgentRun,
  BackgroundAgentSink,
  BackgroundTask,
  BackgroundTaskState,
  ChatBackgroundTasks,
  ChatShellOutput,
  ShellTailView,
  TaskOutputOptions,
} from "./task-types";
export { TASK_ID_PATTERN } from "./task-types";
export { createTasksProvider } from "./tasks-provider";
