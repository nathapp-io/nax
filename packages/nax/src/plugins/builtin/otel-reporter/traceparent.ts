export interface Traceparent {
  traceId: string;
  spanId: string;
}

const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO = /^0+$/;

/**
 * Parse a W3C `traceparent` header value. Returns `null` when the value is
 * missing, malformed, or carries an all-zero trace id (per the spec, an
 * invalid/root marker rather than a real parent).
 */
export function parseTraceparent(value: string | undefined): Traceparent | null {
  if (!value) return null;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) return null;
  const [, traceId, spanId] = match;
  if (!traceId || !spanId || ALL_ZERO.test(traceId)) return null;
  return { traceId, spanId };
}
