import type { AgentError } from "../types";

/**
 * Parse stderr output to identify agent error type.
 *
 * Detects common error patterns:
 * - Rate limit errors: 429, "rate limit", "Rate limit"
 * - Auth errors: 401, 403, "unauthorized", "Unauthorized", "forbidden", "Forbidden"
 * - Unknown for unrecognized patterns
 *
 * Optionally extracts retryAfterSeconds for rate limit errors.
 */
export function parseAgentError(stderr: string): AgentError {
  if (!stderr) {
    return { type: "unknown" };
  }

  // Check for rate limit patterns (429, "rate limit", "Rate limit")
  if (stderr.includes("429") || stderr.includes("rate limit") || stderr.includes("Rate limit")) {
    const result: AgentError = { type: "rate-limit" };

    // Try to extract retryAfterSeconds from "retry after N" patterns
    const match = stderr.match(/retry\s+after\s+(\d+)/i);
    if (match?.[1]) {
      result.retryAfterSeconds = Number.parseInt(match[1], 10);
    }

    return result;
  }

  // Check for auth patterns (401, 403, "unauthorized", "Unauthorized", "forbidden", "Forbidden")
  if (
    stderr.includes("401") ||
    stderr.includes("403") ||
    stderr.includes("unauthorized") ||
    stderr.includes("Unauthorized") ||
    stderr.includes("forbidden") ||
    stderr.includes("Forbidden")
  ) {
    return { type: "auth" };
  }

  // Unknown error type
  return { type: "unknown" };
}
