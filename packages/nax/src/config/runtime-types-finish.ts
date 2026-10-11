/**
 * `finish` config types — the in-process native finish phase (nax-finish).
 *
 * Split out of `runtime-types.ts`, which is at its file-size limit.
 */

import type { ConfiguredModel } from "./schema-types";

/** Wall-clock budgets for the native finish phase (ms) */
export interface FinishTimeoutsConfig {
  acceptanceMs: number;
  gateMs: number;
  flowMs: number;
  /** Per LLM op; null keeps callOp's own default */
  stepMs: number | null;
}

/** `finish` config block — the in-process post-run finish phase (opt-in, off by default) */
export interface FinishConfig {
  enabled: boolean;
  /** Deprecated, ignored (A4) */
  narrative: boolean;
  prBody: { template: "merge" | "strict" | "ignore"; sectionMap: Record<string, string> };
  /** Per-step model selection; null falls through to callOp's default */
  reviewers: {
    spec: ConfiguredModel | null;
    quality: ConfiguredModel | null;
    /** Deprecated, ignored (A4) */
    narrative: ConfiguredModel | null;
    fix: ConfiguredModel | null;
  };
  escalate: { telegram: boolean };
  /** `escalation` is the pre-A4 alias of `draft`. */
  notify: { mode: "draft" | "escalation" | "always" | "off" };
  timeouts: FinishTimeoutsConfig;
}
