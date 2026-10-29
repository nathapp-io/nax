import type { BackgroundTask } from "./task-types";

/** Plain-text rows appended to /jobs; empty registries add nothing. */
export function formatTasksListing(tasks: readonly BackgroundTask[]): string {
  return tasks.map((task) => `${task.id} ${task.state} ${task.command}`).join("\n");
}
