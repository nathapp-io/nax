import type { BackgroundCommandPort, SessionEvent } from "@nathapp/nax-agent";

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
  /** The model the run resolved to, for the agent view's header. */
  readonly model?: string;
  /** Always resolves. */
  readonly ended: Promise<BackgroundAgentEnd>;
  stop(): void;
}

export interface BackgroundAgentSink {
  readonly id: string;
  /** Append one line to the task log while the task runs. */
  appendLine(line: string): void;
  /** Record one session event of the run, for the agent view; bounded, oldest dropped first. */
  record(event: SessionEvent): void;
}

/** A background agent run as the full-screen agent view reads it. */
export interface BackgroundAgentRun {
  readonly id: string;
  /** The qualified agent name. */
  readonly agent: string;
  readonly model?: string;
  /** The whole task prompt, the view's first user message. */
  readonly prompt: string;
  readonly state: BackgroundTaskState;
  /** The retained events, oldest first. */
  readonly events: readonly SessionEvent[];
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
  /** The agent run `id` names, or undefined for an unknown id or a shell task. */
  agentRun(id: string): BackgroundAgentRun | undefined;
  /** Told the id of an agent task each time it records an event; returns the unsubscribe. */
  onAgentEvents(listener: (id: string) => void): () => void;
  hasForeground(): boolean;
  /** Stable completion snapshot until takeNotice consumes exactly those tasks. */
  peekNotice(): string | undefined;
  /**
   * Drop the snapshot a peek pinned without consuming the tasks it names, for a peek that
   * delivered nothing: the notice stays queued and a read of those tasks still retires it.
   */
  releaseNotice(): void;
  takeNotice(): string | undefined;
  onChange(listener: () => void): () => void;
  list(): readonly BackgroundTask[];
  get(id: string): BackgroundTask | undefined;
  running(): readonly BackgroundTask[];
  output(id: string, lines?: number, options?: TaskOutputOptions): Promise<string>;
}
