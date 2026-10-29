import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { buildBackgroundTasksInstructions } from "@/prompts";
import { TASK_OUTPUT_MAX_LINES } from "./task-registry";
import { type BackgroundTask, type ChatBackgroundTasks, TASK_ID_PATTERN } from "./task-types";

function summary(task: BackgroundTask): Record<string, unknown> {
  const { id, command, state, startedAt, endedAt, exitCode } = task;
  return { id, command, state, startedAt, endedAt, exitCode };
}

async function inspectTask(
  name: "output" | "stop",
  tasks: ChatBackgroundTasks,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const id = input.task;
  if (typeof id !== "string" || !TASK_ID_PATTERN.test(id)) {
    return { isError: true, content: `[chat] invalid task id ${String(id)}` };
  }
  const task = tasks.get(id);
  if (!task) return { isError: true, content: `[chat] unknown task ${id}` };
  if (name === "stop") {
    if (task.state !== "running") return { isError: true, content: `[chat] task ${id} is not running` };
    tasks.stop(id);
    return { content: `stopped task ${id}` };
  }
  const lines = input.lines;
  if (
    lines !== undefined &&
    (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > TASK_OUTPUT_MAX_LINES)
  ) {
    return { isError: true, content: `[chat] lines must be an integer from 1 to ${TASK_OUTPUT_MAX_LINES}` };
  }
  return { content: JSON.stringify({ ...task, output: await tasks.output(id, lines) }) };
}

function taskTool(name: "output" | "stop", tasks: ChatBackgroundTasks): ProviderTool {
  return {
    localName: name,
    description:
      name === "output"
        ? "Read a bounded tail of a background command's output."
        : "Stop a background command started by this chat; no approval required.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        ...(name === "output" ? { lines: { type: "integer", minimum: 1, maximum: TASK_OUTPUT_MAX_LINES } } : {}),
      },
      required: ["task"],
      additionalProperties: false,
    },
    run: (input) => inspectTask(name, tasks, input),
  };
}

/** Chat-owned static inspection tools; stopping only affects this chat's commands. */
export function createTasksProvider(tasks: ChatBackgroundTasks): ToolProvider {
  return {
    id: "nax-tasks",
    kind: "static",
    stages: ["*"],
    instructions: async () => buildBackgroundTasksInstructions(),
    tools: async () => [
      {
        localName: "list",
        description: "List this chat's background commands.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        run: async () => ({ content: JSON.stringify({ tasks: tasks.list().map(summary) }) }),
      },
      taskTool("output", tasks),
      taskTool("stop", tasks),
    ],
  };
}
