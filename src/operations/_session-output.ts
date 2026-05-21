/**
 * Shared JSON parser for implementer/test-writer/verifier session output.
 * All three ops emit the same `{ success, filesChanged }` envelope; this
 * helper centralises the graceful-degradation path (parse failure or
 * missing fields => success=false, filesChanged=[]).
 */
export interface SessionOutputEnvelope {
  readonly success: boolean;
  readonly filesChanged: readonly string[];
  readonly output: string;
  readonly parsed: boolean;
}

const EMPTY: SessionOutputEnvelope = { success: false, filesChanged: [], output: "", parsed: false };

export function parseSessionJsonOutput(output: string): SessionOutputEnvelope {
  if (!output) return EMPTY;
  try {
    const v = JSON.parse(output) as Record<string, unknown>;
    if (v === null || typeof v !== "object" || typeof v.success !== "boolean") {
      return { ...EMPTY, output };
    }
    return {
      success: v.success,
      filesChanged: Array.isArray(v.filesChanged) ? (v.filesChanged as string[]) : [],
      output,
      parsed: true,
    };
  } catch {
    return { ...EMPTY, output };
  }
}
