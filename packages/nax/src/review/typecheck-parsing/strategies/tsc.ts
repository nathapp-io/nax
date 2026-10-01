import type { TypecheckDiagnostic, TypecheckParseResult, TypecheckParseStrategy } from "../types";

const TSC_COMPACT_RE = /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\):\s+error\s+TS(?<code>\d+):\s+(?<message>.+)$/;
const TSC_PRETTY_RE = /^(?<file>.+):(?<line>\d+):(?<column>\d+)\s+-\s+error\s+TS(?<code>\d+):\s+(?<message>.+)$/;
const SUMMARY_LINE_RE = /^Found \d+ errors? in \d+ files?\.$/i;

interface HeaderMatch {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

function parseHeader(line: string): HeaderMatch | null {
  const compact = TSC_COMPACT_RE.exec(line);
  if (compact?.groups) {
    return {
      file: compact.groups.file,
      line: Number.parseInt(compact.groups.line, 10),
      column: Number.parseInt(compact.groups.column, 10),
      code: compact.groups.code,
      message: compact.groups.message.trim(),
    };
  }

  const pretty = TSC_PRETTY_RE.exec(line);
  if (pretty?.groups) {
    return {
      file: pretty.groups.file,
      line: Number.parseInt(pretty.groups.line, 10),
      column: Number.parseInt(pretty.groups.column, 10),
      code: pretty.groups.code,
      message: pretty.groups.message.trim(),
    };
  }

  return null;
}

function isSummaryLine(line: string): boolean {
  return SUMMARY_LINE_RE.test(line.trim());
}

export function parseTscOutput(output: string): TypecheckParseResult | null {
  if (!output.trim()) return null;

  const lines = output.split(/\r?\n/);
  const diagnostics: TypecheckDiagnostic[] = [];
  let current: (TypecheckDiagnostic & { lines: string[] }) | null = null;

  const flush = (): void => {
    if (!current) return;
    while (current.lines.length > 0 && isSummaryLine(current.lines[current.lines.length - 1] ?? "")) {
      current.lines.pop();
    }
    current.raw = current.lines.join("\n").trimEnd();
    if (current.raw.trim()) {
      diagnostics.push({
        file: current.file,
        line: current.line,
        column: current.column,
        code: current.code,
        message: current.message,
        raw: current.raw,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const header = parseHeader(line);
    if (header) {
      flush();
      current = {
        file: header.file,
        line: header.line,
        column: header.column,
        code: header.code,
        message: header.message,
        raw: line,
        lines: [line],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  flush();
  if (diagnostics.length === 0) return null;
  return { diagnostics, format: "tsc" };
}

export const tscStrategy: TypecheckParseStrategy = {
  name: "tsc",
  parse: parseTscOutput,
};
