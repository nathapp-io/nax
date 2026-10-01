import type { LintDiagnostic, LintParseResult, LintParseStrategy } from "../types";

interface EslintMessage {
  line?: number;
  column?: number;
  severity?: number;
  ruleId?: string | null;
  message?: string;
}

interface EslintResultEntry {
  filePath?: string;
  messages?: EslintMessage[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function getEntries(payload: unknown): EslintResultEntry[] {
  if (Array.isArray(payload)) {
    return payload as EslintResultEntry[];
  }
  const record = asRecord(payload);
  const results = record?.results;
  return Array.isArray(results) ? (results as EslintResultEntry[]) : [];
}

function mapSeverity(value: number | undefined): "error" | "warning" | "info" {
  if (value === 2) return "error";
  if (value === 1) return "warning";
  return "info";
}

function toDiagnostic(file: string, message: EslintMessage): LintDiagnostic | null {
  if (!message.message) return null;
  return {
    file,
    line: typeof message.line === "number" ? message.line : undefined,
    column: typeof message.column === "number" ? message.column : undefined,
    severity: mapSeverity(message.severity),
    ruleId: message.ruleId ?? undefined,
    message: message.message,
    raw: `${file}:${message.line ?? 0}:${message.column ?? 0} ${message.message}`,
  };
}

export function parseEslintJson(output: string): LintParseResult | null {
  if (!output.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  const entries = getEntries(parsed);
  if (entries.length === 0) return null;

  const diagnostics = entries.flatMap((entry) => {
    const file = typeof entry.filePath === "string" ? entry.filePath : "";
    if (!file || !Array.isArray(entry.messages)) return [];
    return entry.messages.map((m) => toDiagnostic(file, m)).filter((d): d is LintDiagnostic => d !== null);
  });

  if (diagnostics.length === 0) return null;
  return { diagnostics, format: "eslint-json" };
}

export const eslintJsonStrategy: LintParseStrategy = {
  name: "eslint-json",
  parse: parseEslintJson,
};
