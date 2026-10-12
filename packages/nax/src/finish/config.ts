/**
 * Reading the `finish.*` config slice into the shapes the phase and
 * `createFinishOps` take.
 *
 * The one module that knows config key names. `createFinishOps` deliberately
 * reads no config (plan 4, D4.8) so it stays drivable from a literal in tests;
 * this is where the literal comes from in production.
 *
 * Reads through `finishConfigSelector` rather than indexing `config.finish`
 * directly, so the dependency stays declared in `src/config/selectors.ts`.
 */

import type { ConfiguredModel, NaxConfig } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishPrBodySettings } from "./types";

export interface FinishSettings {
  enabled: boolean;
  /** True when a pre-A4 `finish.narrative` / `finish.reviewers.narrative` setting is present; it is ignored. */
  deprecatedNarrative: boolean;
  prBody: FinishPrBodySettings;
  /** Exactly `FinishOpsDeps["models"]`: an absent key means "callOp's default". */
  models: {
    reviewSpec?: ConfiguredModel;
    reviewQuality?: ConfiguredModel;
    fix?: ConfiguredModel;
  };
  escalate: { telegram: boolean };
  notify: { mode: "draft" | "always" | "off" };
  /**
   * Cross-run idempotency (#1674 part 1). `on-change` (default) skips the
   * phase when the ledger's branch/HEAD already match a terminal outcome;
   * `always` bypasses the ledger entirely, matching pre-ledger behaviour.
   */
  rerun: "on-change" | "always";
  timeouts: { acceptanceMs: number; gateMs: number; flowMs: number; reviewMs: number; fixMs: number };
}

const DEFAULTS: Omit<FinishSettings, "models"> = {
  enabled: false,
  deprecatedNarrative: false,
  prBody: { template: "merge", sectionMap: {} },
  escalate: { telegram: true },
  notify: { mode: "draft" },
  rerun: "on-change",
  timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 10_800_000, reviewMs: 900_000, fixMs: 1_200_000 },
};

/** Drop null/undefined slots so an absent selection reaches callOp as `undefined`, not `null`. */
function modelsOf(reviewers: Record<string, ConfiguredModel | null | undefined> | undefined): FinishSettings["models"] {
  const map: Array<[keyof FinishSettings["models"], string]> = [
    ["reviewSpec", "spec"],
    ["reviewQuality", "quality"],
    ["fix", "fix"],
  ];
  const out: FinishSettings["models"] = {};
  for (const [target, source] of map) {
    const value = reviewers?.[source];
    if (value !== null && value !== undefined) out[target] = value;
  }
  return out;
}

/** `escalation` is the pre-A4 name for what is now `draft`. */
function notifyMode(raw: "draft" | "escalation" | "always" | "off" | undefined): FinishSettings["notify"]["mode"] {
  if (raw === undefined || raw === "escalation") return DEFAULTS.notify.mode;
  return raw;
}

export function readFinishConfig(config: unknown): FinishSettings {
  const finish =
    config && typeof config === "object"
      ? (finishConfigSelector.select(config as NaxConfig)?.finish as
          | (Partial<Omit<FinishSettings, "notify">> & {
              narrative?: boolean;
              reviewers?: Record<string, ConfiguredModel | null>;
              notify?: { mode?: "draft" | "escalation" | "always" | "off" };
            })
          | undefined)
      : undefined;
  if (!finish) return { ...DEFAULTS, models: {} };
  return {
    enabled: finish.enabled === true,
    // After parsing both keys are always present (true / null defaults), so
    // "set" means a non-default value.
    deprecatedNarrative: finish.narrative === false || finish.reviewers?.narrative != null,
    prBody: {
      template: finish.prBody?.template ?? DEFAULTS.prBody.template,
      sectionMap: finish.prBody?.sectionMap ?? DEFAULTS.prBody.sectionMap,
    },
    models: modelsOf(finish.reviewers),
    escalate: { telegram: finish.escalate?.telegram !== false },
    notify: { mode: notifyMode(finish.notify?.mode) },
    rerun: finish.rerun ?? DEFAULTS.rerun,
    timeouts: {
      acceptanceMs: finish.timeouts?.acceptanceMs ?? DEFAULTS.timeouts.acceptanceMs,
      gateMs: finish.timeouts?.gateMs ?? DEFAULTS.timeouts.gateMs,
      flowMs: finish.timeouts?.flowMs ?? DEFAULTS.timeouts.flowMs,
      reviewMs: finish.timeouts?.reviewMs ?? DEFAULTS.timeouts.reviewMs,
      fixMs: finish.timeouts?.fixMs ?? DEFAULTS.timeouts.fixMs,
    },
  };
}
