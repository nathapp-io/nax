import type { BackgroundCommandPort } from "@nathapp/nax-agent";

export type BackgroundTaskState = "running" | "succeeded" | "failed" | "stopped";

/** Host-owned, in-memory record. Only its machine-local log survives the chat. */
export interface BackgroundTask {
  readonly id: string;
  readonly command: string;
  readonly description?: string;
  readonly origin: "agent" | "moved";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly state: BackgroundTaskState;
  readonly exitCode?: number;
  readonly note?: string;
  readonly logPath: string;
  /** Absent for a shell command; "agent" for a background subagent run. */
  readonly kind?: "agent";
}

export const TASK_ID_PATTERN = /^(bash|agent)-[0-9a-f]{8}$/;

export type BackgroundAgentOutcome = "succeeded" | "failed" | "stopped";

export interface BackgroundAgentEnd {
  readonly outcome: BackgroundAgentOutcome;
  /** The subagent's final answer, or the error text of a failed run. */
  readonly text: string;
}

export interface BackgroundAgentHandle {
  /** The qualified agent name the run resolved to (`general` for the built-in agent). */
  readonly agent: string;
  readonly task: string;
  /** Always resolves. */
  readonly ended: Promise<BackgroundAgentEnd>;
  stop(): void;
}

export interface BackgroundAgentSink {
  readonly id: string;
  /** Append one line to the task log while the task runs. */
  appendLine(line: string): void;
}

/** Options for {@link ChatBackgroundTasks.output}; only the agent's own tool reads mark seen. */
export interface TaskOutputOptions {
  /** Drop the completion notice when the read reports a task that had already finished. */
  readonly markSeen?: boolean;
}

/** Host-owned command lifecycle, independent of the current session. */
export interface ChatBackgroundTasks extends BackgroundCommandPort {
  /** Adopt a background subagent run; its log lines are appended through the returned sink. */
  adoptAgent(handle: BackgroundAgentHandle): BackgroundAgentSink;
  stop(id: string): BackgroundTask;
  stopAll(): Promise<void>;
  moveForeground(): boolean;
  hasForeground(): boolean;
  /** Stable completion snapshot until takeNotice consumes exactly those tasks. */
  peekNotice(): string | undefined;
  takeNotice(): string | undefined;
  onChange(listener: () => void): () => void;
  list(): readonly BackgroundTask[];
  get(id: string): BackgroundTask | undefined;
  running(): readonly BackgroundTask[];
  output(id: string, lines?: number, options?: TaskOutputOptions): Promise<string>;
}
