/**
 * `advisor` config types — A1 advisor (rules on judgment calls instead of stopping the run).
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit.
 */
import type { ConfiguredModel } from "./schema-types";

export interface AdvisorCallersConfig {
  finishJudgment: boolean;
  fixCycleGiveUp: boolean;
  uncategorisedFailure: boolean;
  finishApproval: boolean;
}

/** `advisor` block. Root-only (pinned in `root-only-keys.ts`). Every caller is off by default. */
export interface AdvisorConfig {
  enabled: boolean;
  model: ConfiguredModel;
  memory: "stateless" | "warm";
  callers: AdvisorCallersConfig;
  /** Kind 2 + 3 decisions allowed per story across the whole feature. */
  maxRulingsPerStory: number;
  notify: { headsUp: boolean };
  timeoutMs?: number;
}

export type AdvisorCaller = keyof AdvisorCallersConfig;
