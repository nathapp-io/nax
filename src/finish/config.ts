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
import { finishConfigSelector } from "@/config";
import type { ConfiguredModel, NaxConfig } from "@/config";
import type { FinishPrBodySettings } from "./types";

export interface FinishSettings {
  enabled: boolean;
  narrative: boolean;
  prBody: FinishPrBodySettings;
  /** Exactly `FinishOpsDeps["models"]`: an absent key means "callOp's default". */
  models: {
    reviewSpec?: ConfiguredModel;
    reviewQuality?: ConfiguredModel;
    fix?: ConfiguredModel;
    narrative?: ConfiguredModel;
  };
  escalate: { telegram: boolean };
  notify: { mode: "escalation" | "always" | "off" };
  /**
   * Cross-run idempotency (#1674 part 1). `on-change` (default) skips the
   * phase when the ledger's branch/HEAD already match a terminal outcome;
   * `always` bypasses the ledger entirely, matching pre-ledger behaviour.
   */
  rerun: "on-change" | "always";
  timeouts: { acceptanceMs: number; gateMs: number; flowMs: number; stepMs: number | null };
}

const DEFAULTS: Omit<FinishSettings, "models"> = {
  enabled: false,
  narrative: true,
  prBody: { template: "merge", sectionMap: {} },
  escalate: { telegram: true },
  notify: { mode: "escalation" },
  rerun: "on-change",
  timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
};

/** Drop null/undefined slots so an absent selection reaches callOp as `undefined`, not `null`. */
function modelsOf(reviewers: Record<string, ConfiguredModel | null | undefined> | undefined): FinishSettings["models"] {
  const map: Array<[keyof FinishSettings["models"], string]> = [
    ["reviewSpec", "spec"],
    ["reviewQuality", "quality"],
    ["fix", "fix"],
    ["narrative", "narrative"],
  ];
  const out: FinishSettings["models"] = {};
  for (const [target, source] of map) {
    const value = reviewers?.[source];
    if (value !== null && value !== undefined) out[target] = value;
  }
  return out;
}

export function readFinishConfig(config: unknown): FinishSettings {
  const finish =
    config && typeof config === "object"
      ? (finishConfigSelector.select(config as NaxConfig)?.finish as
          | (Partial<FinishSettings> & {
              reviewers?: Record<string, ConfiguredModel | null>;
            })
          | undefined)
      : undefined;
  if (!finish) return { ...DEFAULTS, models: {} };
  return {
    enabled: finish.enabled === true,
    // `!== false` so an older config with no key still narrates, matching the
    // schema default rather than silently opting out.
    narrative: finish.narrative !== false,
    prBody: {
      template: finish.prBody?.template ?? DEFAULTS.prBody.template,
      sectionMap: finish.prBody?.sectionMap ?? DEFAULTS.prBody.sectionMap,
    },
    models: modelsOf(finish.reviewers),
    escalate: { telegram: finish.escalate?.telegram !== false },
    notify: { mode: finish.notify?.mode ?? DEFAULTS.notify.mode },
    rerun: finish.rerun ?? DEFAULTS.rerun,
    timeouts: {
      acceptanceMs: finish.timeouts?.acceptanceMs ?? DEFAULTS.timeouts.acceptanceMs,
      gateMs: finish.timeouts?.gateMs ?? DEFAULTS.timeouts.gateMs,
      flowMs: finish.timeouts?.flowMs ?? DEFAULTS.timeouts.flowMs,
      stepMs: finish.timeouts?.stepMs ?? DEFAULTS.timeouts.stepMs,
    },
  };
}
