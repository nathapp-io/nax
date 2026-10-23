import type { TypecheckDiagnostic, TypecheckParseResult, TypecheckParseStrategy } from "../types";

function parseBlock(lines: readonly string[]): TypecheckDiagnostic | null {
  const header = /^<error\s+([^>]+)>(.*)$/.exec(lines[0] ?? "");
  if (!header) return null;
  const attributes = new Map(
    Array.from(header[1].matchAll(/\b(file|line|column|code)="([^"]*)"/g), (match) => [match[1], match[2]]),
  );
  const file = attributes.get("file");
  const line = attributes.get("line");
  if (!file || !line) return null;
  const column = attributes.get("column");
  const message =
    [header[2], ...lines.slice(1)]
      .map((text) => text.trim())
      .find((text) => text.length > 0 && !text.startsWith("<")) ?? "";
  return {
    file,
    line: Number.parseInt(line, 10),
    column: column ? Number.parseInt(column, 10) : undefined,
    code: attributes.get("code")?.replace(/^TS/, ""),
    message,
    raw: lines.join("\n"),
  };
}

function parseBunCheckOutput(output: string): TypecheckParseResult | null {
  const diagnostics: TypecheckDiagnostic[] = [];
  let block: string[] = [];
  const flush = (): void => {
    const diagnostic = parseBlock(block);
    if (diagnostic) diagnostics.push(diagnostic);
    block = [];
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("<error ")) {
      flush();
      block = [line];
    } else if (block.length > 0) {
      block.push(line);
      if (line === "</error>") flush();
    }
  }
  flush();
  return diagnostics.length > 0 ? { diagnostics, format: "bun-check" } : null;
}

/** Bun's TypeScript checker emits line-delimited error blocks, not XML documents. */
export const bunCheckStrategy: TypecheckParseStrategy = {
  name: "bun-check",
  parse: parseBunCheckOutput,
};
