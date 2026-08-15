/**
 * Tool Diagnostics Parser
 *
 * US-001: Parses raw tool output from a QualityCommandResult into a list of
 * structured Diagnostic records. Authoritative provenance for lint and
 * typecheck failures — the rectifier retrying a story uses these instead of
 * the agent's prose self-verification.
 *
 * Tool coverage:
 * - `tsc` — uses the existing tsc parser (compact + pretty forms)
 * - `biome` — uses the existing biome-json parser
 * - everything else — degrades to one Diagnostic carrying a bounded tail of
 *   raw output, so a new language is never a hard error and never silently empty
 *
 * Bounded tail: `MAX_RAW_TAIL_CHARS` chars, taken from the END of output.
 *
 * @see docs/specs/context-providers-22/spec.md (US-001)
 */

import { parseLintOutput } from "../review/lint-parsing";
import { parseTypecheckOutput } from "../review/typecheck-parsing";
import type { QualityCommandResult } from "./runner";

/** Maximum number of raw-output chars preserved for an unrecognised tool. */
export const MAX_RAW_TAIL_CHARS = 2_000;

/** Structured diagnostic produced by `parseDiagnostics`. */
export interface Diagnostic {
  file: string;
  line?: number;
  column?: number;
  severity: string;
  message: string;
  /** Linter rule id (e.g. `lint/no-unused-vars`); absent for typecheck. */
  rule?: string;
  /** Tool that emitted this diagnostic (`tsc`, `biome`, ...). */
  tool: string;
}

/**
 * Parse a QualityCommandResult into a list of structured Diagnostics.
 *
 * Per-toolchain parsing degrades rather than fails: an unrecognised tool (or a
 * recognised one whose output the parser couldn't understand) yields a single
 * Diagnostic carrying a bounded tail of the raw output — never a hard error and
 * never silently empty.
 *
 * Empty output returns `[]` regardless of tool.
 */
export async function parseDiagnostics(result: QualityCommandResult, tool: string): Promise<Diagnostic[]> {
  const output = result.output ?? "";
  if (!output.trim()) return [];

  if (tool === "tsc") {
    const parsed = parseTypecheckOutput(output, "tsc");
    if (parsed && parsed.diagnostics.length > 0) {
      return parsed.diagnostics.map((d) => ({
        file: d.file,
        line: d.line,
        column: d.column,
        severity: "error",
        message: d.message,
        tool: "tsc",
      }));
    }
  }

  if (tool === "biome") {
    const parsed = parseLintOutput(output, "biome-json");
    if (parsed && parsed.diagnostics.length > 0) {
      return parsed.diagnostics.map((d) => ({
        file: d.file,
        line: d.line,
        column: d.column,
        severity: d.severity ?? "error",
        message: d.message,
        rule: d.ruleId,
        tool: "biome",
      }));
    }
  }

  // Degraded raw-tail path for unrecognised toolchains (or unparseable output).
  const tail = output.slice(-MAX_RAW_TAIL_CHARS).trim();
  return [{ file: "", severity: "error", message: tail, tool }];
}
