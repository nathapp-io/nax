import type { TypecheckDiagnostic, TypecheckParseResult, TypecheckParseStrategy } from "../types";

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|go|py|rs|rb|java|cs|cpp|c|h|swift|kt)$/;
const PATH_RE = /^[ \t]*((?:\/[\w./-]+|\.\.?\/[\w./-]+|[\w][\w-]*(?:\/[\w./-]+)+))(?::\d+)?(?::\d+)?(?:\s|:|$)/;
const LOCATION_RE = /:(\d+)(?::(\d+))?/;
const SUMMARY_LINE_RE = /^(Found \d+ .+|Checked \d+ .+|[\d\s]+errors?\b.*|[\d\s]+problems?\b.*)$/i;

interface TextBlock {
  file: string;
  text: string;
}

function parseLocation(text: string): { line?: number; column?: number } {
  const match = LOCATION_RE.exec(text);
  if (!match) return {};
  const line = Number.parseInt(match[1], 10);
  if (Number.isNaN(line)) return {};
  const parsedColumn = match[2] ? Number.parseInt(match[2], 10) : undefined;
  const column = parsedColumn !== undefined && !Number.isNaN(parsedColumn) ? parsedColumn : undefined;
  return { line, column };
}

function stripTrailingSummaryLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0) {
    const last = next[next.length - 1]?.trim() ?? "";
    if (!last) {
      next.pop();
      continue;
    }
    if (!SUMMARY_LINE_RE.test(last)) {
      break;
    }
    next.pop();
  }
  return next;
}

function pushBlock(blocks: TextBlock[], current: { file: string; lines: string[] } | null): void {
  if (!current) return;
  const cleaned = stripTrailingSummaryLines(current.lines);
  const text = cleaned.join("\n").trimEnd();
  if (!text.trim()) return;
  blocks.push({ file: current.file, text });
}

function collectBlocks(output: string): TextBlock[] {
  const lines = output.split(/\r?\n/);
  const blocks: TextBlock[] = [];
  let current: { file: string; lines: string[] } | null = null;

  for (const line of lines) {
    const pathMatch = PATH_RE.exec(line);
    const candidate = pathMatch?.[1] ?? "";
    const hasSupportedPath = candidate.length > 0 && SOURCE_EXT_RE.test(candidate);
    if (hasSupportedPath) {
      pushBlock(blocks, current);
      current = { file: candidate, lines: [line] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  pushBlock(blocks, current);
  return blocks;
}

export function parseTypecheckTextBlocks(output: string): TypecheckParseResult | null {
  if (!output.trim()) return null;
  const blocks = collectBlocks(output);
  if (blocks.length === 0) return null;

  const diagnostics: TypecheckDiagnostic[] = blocks.map((block) => {
    const firstLine = block.text.split(/\r?\n/, 1)[0] ?? block.text;
    const { line, column } = parseLocation(firstLine);
    return {
      file: block.file,
      line,
      column,
      message: firstLine.trim(),
      raw: block.text,
    };
  });

  return { diagnostics, format: "text-block" };
}

export const typecheckTextBlockStrategy: TypecheckParseStrategy = {
  name: "text-block",
  parse: parseTypecheckTextBlocks,
};
