import type { TokenUsage } from "./types";

/**
 * Generic mapper from an external wire format to internal canonical TokenUsage.
 * Each adapter package provides a concrete implementation parameterised by its
 * own wire type. The cost module never imports any specific Wire.
 */
export interface ITokenUsageMapper<Wire> {
  toInternal(wire: Wire): TokenUsage;
}
