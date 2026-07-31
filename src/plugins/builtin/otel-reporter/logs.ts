import type { LogEntry, LogLevel } from "@/logger/types";
import { type KeyValue, attr, buildResourceAttributes, msToUnixNano } from "./otlp";

/** OTLP/JSON LogRecord — body/stringValue subset used by this reporter. */
export interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: KeyValue[];
}

/** Resource inputs shared by logs export (same shape as the existing payload builders). */
export interface LogsResourceInput {
  serviceName: string;
  runId: string;
  feature?: string;
  project?: string;
  git?: { branch?: string; sha?: string };
}

const SEVERITY: Record<LogLevel, { number: number; text: string }> = {
  silent: { number: 0, text: "SILENT" },
  error: { number: 17, text: "ERROR" },
  warn: { number: 13, text: "WARN" },
  info: { number: 9, text: "INFO" },
  debug: { number: 5, text: "DEBUG" },
};

const DATA_JSON_MAX = 2048;
const TRUNCATION_MARKER = "...[truncated]";

function entryTimestampMs(entry: LogEntry): number {
  return new Date(entry.timestamp).getTime();
}

/** Build the OTLP `LogRecord` payload for a single `LogEntry`. */
export function toLogRecord(entry: LogEntry): LogRecord {
  const timeUnixNano = msToUnixNano(entryTimestampMs(entry));
  const { number: severityNumber, text: severityText } = SEVERITY[entry.level];

  const attributes: KeyValue[] = [attr("nax.stage", entry.stage)];
  if (entry.storyId !== undefined) attributes.push(attr("nax.story_id", entry.storyId));
  if (entry.sessionRole !== undefined) attributes.push(attr("nax.session_role", entry.sessionRole));

  const data = entry.data ?? {};
  const nonScalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      attributes.push(attr(`nax.data.${key}`, value));
    } else if (typeof value === "number") {
      attributes.push(attr(`nax.data.${key}`, value));
    } else if (typeof value === "boolean") {
      attributes.push(attr(`nax.data.${key}`, String(value)));
    } else {
      nonScalars[key] = value;
    }
  }
  if (Object.keys(nonScalars).length > 0) {
    attributes.push(attr("nax.data_json", truncate(JSON.stringify(nonScalars))));
  }

  return {
    timeUnixNano,
    severityNumber,
    severityText,
    body: { stringValue: entry.message },
    attributes,
  };
}

/** Build an OTLP/HTTP-JSON ResourceLogs payload from a batch of `LogEntry` values. */
export function buildLogsPayload(entries: LogEntry[], resource: LogsResourceInput): object {
  const logRecords = entries.map(toLogRecord);
  return {
    resourceLogs: [
      {
        resource: {
          attributes: buildResourceAttributes(resource),
        },
        scopeLogs: [{ scope: { name: "nax" }, logRecords }],
      },
    ],
  };
}

function truncate(value: string): string {
  if (value.length <= DATA_JSON_MAX) return value;
  const marker = TRUNCATION_MARKER;
  const keep = DATA_JSON_MAX - marker.length;
  return `${value.slice(0, keep)}${marker}`;
}
