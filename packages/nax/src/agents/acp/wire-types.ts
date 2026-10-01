/**
 * ACP wire types — mirrors the acpx protocol contract.
 *
 * These types use snake_case to match the external wire format.
 * They must never escape the acp/ folder except through
 * AcpTokenUsageMapper.toInternal().
 */

/**
 * Token usage from an ACP session's cumulative_token_usage field.
 * Uses snake_case to match the ACP wire format.
 */
export interface SessionTokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** Cache read tokens — billed at a reduced rate */
  cache_read_input_tokens?: number;
  /** Cache creation tokens — billed at a higher creation rate */
  cache_creation_input_tokens?: number;
}
