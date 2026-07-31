/** Maximum stderr characters included in a one-line action result. */
const STDERR_TAIL_CHARS = 400;

/** Maximum characters retained per subprocess stream in structured logs. */
const LOG_TAIL_CHARS = 20_000;

/** Last `LOG_TAIL_CHARS` of a stream, with an explicit truncation marker. */
export function logTail(stream: string): string {
  if (stream.length <= LOG_TAIL_CHARS) return stream;
  return `[…${stream.length - LOG_TAIL_CHARS} chars truncated…]\n${stream.slice(-LOG_TAIL_CHARS)}`;
}

/** Bounded stderr tail, whitespace-collapsed for one-line action output. */
export function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  const tail = trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
  return tail.replace(/\s+/g, " ");
}
