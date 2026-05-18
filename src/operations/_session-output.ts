/**
 * Shared JSON parser for implementer/test-writer/verifier session output.
 * All three ops emit the same `{ success, filesChanged }` envelope; this
 * helper centralises the graceful-degradation path (parse failure or
 * missing fields => success=false, filesChanged=[]).
 */
export interface SessionOutputEnvelope {
  readonly success: boolean;
  readonly filesChanged: string[];
}

const EMPTY: SessionOutputEnvelope = { success: false, filesChanged: [] };

export function parseSessionJsonOutput(output: string): SessionOutputEnvelope {
  if (!output) return EMPTY;
  try {
    const v = JSON.parse(output) as Record<string, unknown>;
    if (v === null || typeof v !== "object" || typeof v.success !== "boolean") return EMPTY;
    return {
      success: v.success,
      filesChanged: Array.isArray(v.filesChanged) ? (v.filesChanged as string[]) : [],
    };
  } catch {
    return EMPTY;
  }
}
