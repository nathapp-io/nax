/** An AgentLogger that records each line, for asserting what the server logs. */
import type { AgentLogger } from "@nathapp/nax-agent";

export interface LogLine {
  readonly level: "error" | "warn" | "info" | "debug";
  readonly stage: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export function recordingLogger(): { readonly logger: AgentLogger; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine["level"]) =>
    (stage: string, message: string, data?: Record<string, unknown>): void => {
      lines.push({ level, stage, message, ...(data !== undefined ? { data } : {}) });
    };
  return { logger: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") }, lines };
}
