import type { ToolProvider } from "@nathapp/nax-agent";
import { createBackgroundTasks } from "./task-registry";
import type { ChatBackgroundTasks, ChatShellOutput } from "./task-types";
import { createTasksProvider } from "./tasks-provider";

/** Compose one chat-owned registry and its tools, independent of sessions. */
export function createHostTasks(options: Parameters<typeof createBackgroundTasks>[0]): {
  tasks: ChatBackgroundTasks & ChatShellOutput;
  provider: ToolProvider;
} {
  const tasks = createBackgroundTasks(options);
  return { tasks, provider: createTasksProvider(tasks) };
}
