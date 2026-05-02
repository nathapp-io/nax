import type { LintDiagnostic, LintParseResult, LintParseStrategy } from "../types";

interface LocatedDiagnostic {
  file: string;
  line?: number;
  column?: number;
  message: string;
  ruleId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function extractLocation(record: Record<string, unknown>): { file?: string; line?: number; column?: number } {
  const directFile = readString(record, "path") ?? readString(record, "file");
  if (directFile) {
    return {
      file: directFile,
      line: readNumber(record, "line"),
      column: readNumber(record, "column"),
    };
  }

  const location = asRecord(record.location);
  const span = asRecord(location?.span);
  const file = readString(location ?? {}, "path") ?? readString(span ?? {}, "path") ?? readString(span ?? {}, "file");
  if (!file) return {};

  return {
    file,
    line: readNumber(span ?? {}, "line") ?? readNumber(location ?? {}, "line"),
    column: readNumber(span ?? {}, "column") ?? readNumber(location ?? {}, "column"),
  };
}

function collectDiagnostics(node: unknown, sink: LocatedDiagnostic[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectDiagnostics(item, sink);
    }
    return;
  }
  const record = asRecord(node);
  if (!record) return;

  const category = readString(record, "category");
  const severity = readString(record, "severity");
  const message = readString(record, "message") ?? readString(asRecord(record.description) ?? {}, "text");
  const { file, line, column } = extractLocation(record);
  if (file && message && (category?.startsWith("lint/") || severity !== undefined)) {
    sink.push({ file, line, column, message, ruleId: category });
  }

  for (const value of Object.values(record)) {
    collectDiagnostics(value, sink);
  }
}

export function parseBiomeJson(output: string): LintParseResult | null {
  if (!output.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  const found: LocatedDiagnostic[] = [];
  collectDiagnostics(parsed, found);
  if (found.length === 0) return null;

  const diagnostics: LintDiagnostic[] = found.map((entry) => ({
    file: entry.file,
    line: entry.line,
    column: entry.column,
    ruleId: entry.ruleId,
    message: entry.message,
    raw: `${entry.file}:${entry.line ?? 0}:${entry.column ?? 0} ${entry.message}`,
  }));
  return { diagnostics, format: "biome-json" };
}

export const biomeJsonStrategy: LintParseStrategy = {
  name: "biome-json",
  parse: parseBiomeJson,
};
