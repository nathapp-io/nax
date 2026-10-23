import { redactSecrets } from "@/logger";

export const GATE_OUTPUT_TAIL_LINES = 40;
export const GATE_OUTPUT_TAIL_LINE_CHARS = 500;

/** Redact before bounding so truncation cannot expose part of a secret. */
export function gateOutputTail(output: string): string {
  const lines = redactSecrets(output).split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines
    .slice(-GATE_OUTPUT_TAIL_LINES)
    .map((line) =>
      line.length > GATE_OUTPUT_TAIL_LINE_CHARS ? `${line.slice(0, GATE_OUTPUT_TAIL_LINE_CHARS)}…` : line,
    )
    .join("\n");
}
