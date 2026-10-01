/**
 * Parser for ruff's annotated output format (default in ruff 0.4+):
 *
 *   E501 Line too long (110 > 100)
 *       --> tests/unit/data/test_universe.py:1148:101
 *        |
 *   1148 |         """...
 *        |                 ^^^
 *
 * The file path appears on the `-->` line, not at the start of the block.
 * text-block strategy's PATH_RE cannot match this because `-->` is not a
 * path-start character.
 */
import type { LintDiagnostic, LintParseResult, LintParseStrategy } from "../types";
import { SOURCE_EXT_RE } from "./text-block";

const ARROW_RE = /^\s+-->\s+(.+?):(\d+)(?::(\d+))?$/;
const CONTEXT_LINE_RE = /^\s*\d*\s*\|/;

export function parseRuffAnnotated(output: string): LintParseResult | null {
  if (!output.trim()) return null;

  const lines = output.split(/\r?\n/);
  let hasArrow = false;
  for (const line of lines) {
    if (ARROW_RE.test(line)) {
      hasArrow = true;
      break;
    }
  }
  if (!hasArrow) return null;

  const diagnostics: LintDiagnostic[] = [];
  let i = 0;

  while (i < lines.length) {
    const arrowMatch = ARROW_RE.exec(lines[i]);
    if (!arrowMatch || !SOURCE_EXT_RE.test(arrowMatch[1])) {
      i++;
      continue;
    }

    const file = arrowMatch[1];
    const line = Number.parseInt(arrowMatch[2], 10);
    const col = arrowMatch[3] ? Number.parseInt(arrowMatch[3], 10) : undefined;

    // Walk back to collect the message/rule line(s) above the --> line.
    // Stop at blank lines, other --> lines, or source-context lines (|) so we
    // don't bleed into the preceding diagnostic's context block.
    const messageLines: string[] = [];
    let j = i - 1;
    while (j >= 0) {
      const l = lines[j]?.trim() ?? "";
      if (!l || ARROW_RE.test(lines[j] ?? "") || CONTEXT_LINE_RE.test(lines[j] ?? "")) break;
      messageLines.unshift(lines[j] ?? "");
      j--;
    }

    // Walk forward to collect source-context lines (lines with |).
    const contextLines: string[] = [lines[i]];
    let k = i + 1;
    while (k < lines.length && CONTEXT_LINE_RE.test(lines[k])) {
      contextLines.push(lines[k]);
      k++;
    }

    const raw = [...messageLines, ...contextLines].join("\n");
    const message = (messageLines[messageLines.length - 1] ?? file).trim();

    diagnostics.push({ file, line, column: col, message, raw });
    i = k;
  }

  if (diagnostics.length === 0) return null;
  return { diagnostics, format: "ruff-annotated" };
}

export const ruffAnnotatedStrategy: LintParseStrategy = {
  name: "ruff-annotated",
  parse: parseRuffAnnotated,
};
