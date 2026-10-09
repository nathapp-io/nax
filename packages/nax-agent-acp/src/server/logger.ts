/**
 * The server's logger (S5 spec §6.4): JSON lines on stderr, never stdout, which
 * carries ACP frames only. A log call never throws.
 */
import type { AgentLogger } from "@nathapp/nax-agent";

export type LogLevel = "warn" | "info" | "debug";

type Severity = keyof AgentLogger;

const RANK: Readonly<Record<Severity, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

function line(level: Severity, stage: string, message: string, data: Record<string, unknown> | undefined): string {
  const base = { level, stage, message };
  if (data === undefined) return `${JSON.stringify(base)}\n`;
  try {
    return `${JSON.stringify({ ...base, data })}\n`;
  } catch {
    return `${JSON.stringify({ ...base, data: "[unserialisable]" })}\n`;
  }
}

export function stderrLogger(level: LogLevel, write: (text: string) => void): AgentLogger {
  const at =
    (severity: Severity) =>
    (stage: string, message: string, data?: Record<string, unknown>): void => {
      if (RANK[severity] > RANK[level]) return;
      try {
        write(line(severity, stage, message, data));
      } catch {
        // A broken stderr must not take the server down.
      }
    };
  return { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") };
}
