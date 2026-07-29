/**
 * Parse both ACP session IDs from `acpx --format json sessions ensure` stdout.
 *
 * acpx --format json outputs a JSON line:
 *   {"action":"session_ensured","created":true,"acpxRecordId":"<uuid>","acpxSessionId":"<uuid>","name":"<name>"}
 *
 * - `acpxRecordId` — stable record identifier, assigned at creation, never changes across reconnects.
 * - `acpxSessionId` — volatile Claude Code session ID, updated on each Claude Code reconnect.
 *
 * Returns an object with both IDs (undefined when not present in output).
 */
export function parseSessionIds(stdout: string): { sessionId: string | undefined; recordId: string | undefined } {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId = parsed.acpxSessionId;
      const recordId = parsed.acpxRecordId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        return {
          sessionId,
          recordId: typeof recordId === "string" && recordId.length > 0 ? recordId : undefined,
        };
      }
    } catch {
      // not valid JSON — skip
    }
  }
  return { sessionId: undefined, recordId: undefined };
}
