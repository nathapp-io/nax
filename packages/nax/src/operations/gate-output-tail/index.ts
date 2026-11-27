import type { Finding } from "@/findings";
import { redactSecrets } from "@/logger";

export const GATE_OUTPUT_TAIL_LINES = 40;
export const GATE_OUTPUT_TAIL_LINE_CHARS = 500;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2_000;

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

/** Preserve the diagnostic's beginning; the independent output tail supplies the ending. */
function boundedDiagnosticMessage(message: string): string {
  const redacted = redactSecrets(message);
  return redacted.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS)}\n… (diagnostic truncated; re-run the gate for full output)`
    : redacted;
}

/** Partial parsing must not suppress command evidence. Attach it once, before any finding cap. */
export function withGateFailureContext(findings: readonly Finding[], fallback: Finding): Finding[] {
  if (findings.length === 0) return [{ ...fallback, message: redactSecrets(fallback.message) }];
  return findings.map((finding, index) => ({
    ...finding,
    message: `${boundedDiagnosticMessage(finding.message)}${index === 0 ? `\n\n${redactSecrets(fallback.message)}` : ""}`,
  }));
}
