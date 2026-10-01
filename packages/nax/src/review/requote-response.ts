import { tryParseLLMJson } from "../utils/llm-json";

export type ParsedRequoteResponse = {
  file: string;
  line?: number;
  observed: string;
};

export function parseRequoteResponse(output: string): ParsedRequoteResponse | null {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed)) return null;

  const canonical = extractCanonical(parsed);
  if (canonical) return canonical;

  const findings = parsed.findings;
  if (!Array.isArray(findings) || findings.length !== 1) return null;
  const finding = findings[0];
  if (!isRecord(finding)) return null;

  return extractCanonical(finding.verifiedBy) ?? extractCanonical(finding);
}

function extractCanonical(value: unknown): ParsedRequoteResponse | null {
  if (!isRecord(value)) return null;
  if (typeof value.file !== "string" || typeof value.observed !== "string") return null;

  const file = value.file.trim();
  if (!file) return null;

  const line = coerceLine(value.line);
  if (line === null) return null;

  return {
    file,
    line: line === undefined ? undefined : line,
    observed: value.observed,
  };
}

function coerceLine(value: unknown): number | undefined | null {
  if (value == null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
