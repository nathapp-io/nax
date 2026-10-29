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
}

export const TASK_ID_PATTERN = /^bash-[0-9a-f]{8}$/;

/** Adoption and queries; US-008 extends this with the remaining host lifecycle port. */
export interface ChatBackgroundTasks extends Pick<BackgroundCommandPort, "adopt"> {
  list(): readonly BackgroundTask[];
  get(id: string): BackgroundTask | undefined;
  running(): readonly BackgroundTask[];
  output(id: string, lines?: number): Promise<string>;
}
