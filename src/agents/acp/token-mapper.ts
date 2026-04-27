import type { ITokenUsageMapper, TokenUsage } from "../cost";
import type { SessionTokenUsage } from "./wire-types";

export class AcpTokenUsageMapper implements ITokenUsageMapper<SessionTokenUsage> {
  toInternal(wire: SessionTokenUsage): TokenUsage {
    return {
      inputTokens: wire.input_tokens ?? 0,
      outputTokens: wire.output_tokens ?? 0,
      cacheReadInputTokens: wire.cache_read_input_tokens,
      cacheCreationInputTokens: wire.cache_creation_input_tokens,
    };
  }
}

export const defaultAcpTokenUsageMapper = new AcpTokenUsageMapper();
