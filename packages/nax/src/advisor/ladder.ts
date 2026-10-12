/** A5 W-R10: the advisor tries `model`, then each `fallbackModels` entry, skipping any in cooldown. */
import type { AdvisorConfig } from "../config/runtime-types-advisor";
import type { ConfiguredModel } from "../config/schema-types";

export function advisorLadder(config: AdvisorConfig): ConfiguredModel[] {
  const all = [config.model, ...(config.fallbackModels ?? [])];
  return all.filter((m, i) => all.findIndex((o) => Bun.deepEquals(o, m)) === i);
}

export function usableAdvisorModels(
  config: AdvisorConfig,
  isCooling: (model: ConfiguredModel) => boolean,
): ConfiguredModel[] {
  return advisorLadder(config).filter((m) => !isCooling(m));
}

/** Usable entries in order; every entry cooling still yields one attempt per entry rather than none. */
export function ladderModels(config: AdvisorConfig, isCooling: (model: ConfiguredModel) => boolean): ConfiguredModel[] {
  const usable = usableAdvisorModels(config, isCooling);
  return usable.length > 0 ? usable : advisorLadder(config);
}
