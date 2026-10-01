import type { ITokenUsageMapper, TokenUsage } from "../cost";
import type { SessionTokenUsage } from "./wire-types";

/** Coerce a wire token field to a finite number, falling back to 0. Guards
 * against malformed acpx output where a field is present but non-numeric
 * (e.g. a stringified number) — `?? 0` alone only guards undefined/null. */
function toFiniteTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Same guard as toFiniteTokenCount, but preserves `undefined` (absence) instead
 * of coercing it to 0 — cache fields are undefined-safe by design (absence must
 * stay undefined so downstream `addTokenUsage` omits them, not treat them as
 * zero usage). A present-but-malformed value (string, NaN, Infinity) still
 * coerces to 0, same as toFiniteTokenCount. */
function toFiniteOrUndefined(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class AcpTokenUsageMapper implements ITokenUsageMapper<SessionTokenUsage> {
  toInternal(wire: SessionTokenUsage): TokenUsage {
    return {
      // BUG-10: acpx may emit malformed cumulative_token_usage where required
      // fields are missing or non-numeric at runtime — coerce rather than
      // trust the declared (compile-time-only) SessionTokenUsage shape.
      inputTokens: toFiniteTokenCount(wire.input_tokens),
      outputTokens: toFiniteTokenCount(wire.output_tokens),
      // BUG-58: apply the same finite-number guard to the cache fields —
      // previously only input/output_tokens were validated, leaving the same
      // string-concatenation/NaN corruption BUG-10 was meant to prevent
      // reachable via cache_read_input_tokens / cache_creation_input_tokens.
      cacheReadInputTokens: toFiniteOrUndefined(wire.cache_read_input_tokens),
      cacheCreationInputTokens: toFiniteOrUndefined(wire.cache_creation_input_tokens),
    };
  }
}

export const defaultAcpTokenUsageMapper = new AcpTokenUsageMapper();
