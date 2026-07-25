/**
 * nax-finish Plugin — Config Readers
 *
 * `PostRunContext.config` is typed `unknown` (plugins receive whatever the
 * runner loaded), so the `finish` / `interaction` slices are taken through
 * `finishConfigSelector` when the value looks like a parsed NaxConfig, and fall
 * back to schema defaults otherwise. Reading through the named selector keeps
 * this plugin's config dependency declared in `src/config/selectors.ts` rather
 * than as an ad-hoc key list here.
 */

import { finishConfigSelector } from "@/config";
import type { NaxConfig } from "@/config/types";

export interface FinishAutoFlowSettings {
  enabled: boolean;
  flowPath: string;
  defaultAgent: string | null;
  reviewers: { spec: string | null; quality: string | null };
  escalate: { telegram: boolean };
  timeouts: { acceptanceMs: number; gateMs: number; flowMs: number; stepMs: number | null };
}

/**
 * Defaults mirroring `finish.autoFlow` in `src/config/schemas.ts`. They apply
 * only when the plugin is handed a config carrying no `finish` block at all
 * (older configs, and tests that pass a partial object).
 */
const DEFAULT_FINISH_AUTO_FLOW_CONFIG: FinishAutoFlowSettings = {
  enabled: false,
  flowPath: "flows/nax-finish/nax-finish.flow.ts",
  defaultAgent: null,
  reviewers: { spec: null, quality: null },
  escalate: { telegram: true },
  timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
};

function selectFinish(config: unknown): { autoFlow?: Partial<FinishAutoFlowSettings> } | undefined {
  if (!config || typeof config !== "object") return undefined;
  return finishConfigSelector.select(config as NaxConfig)?.finish as
    | { autoFlow?: Partial<FinishAutoFlowSettings> }
    | undefined;
}

/** Read the `finish.autoFlow` slice from `ctx.config`, applying schema defaults when absent. */
export function getFinishAutoFlowConfig(ctx: { config?: unknown }): FinishAutoFlowSettings {
  const autoFlow = selectFinish(ctx.config)?.autoFlow;
  if (!autoFlow) return DEFAULT_FINISH_AUTO_FLOW_CONFIG;
  const defaults = DEFAULT_FINISH_AUTO_FLOW_CONFIG;
  return {
    enabled: autoFlow.enabled === true,
    flowPath: autoFlow.flowPath ?? defaults.flowPath,
    defaultAgent: autoFlow.defaultAgent ?? null,
    reviewers: {
      spec: autoFlow.reviewers?.spec ?? null,
      quality: autoFlow.reviewers?.quality ?? null,
    },
    escalate: { telegram: autoFlow.escalate?.telegram !== false },
    timeouts: {
      acceptanceMs: autoFlow.timeouts?.acceptanceMs ?? defaults.timeouts.acceptanceMs,
      gateMs: autoFlow.timeouts?.gateMs ?? defaults.timeouts.gateMs,
      flowMs: autoFlow.timeouts?.flowMs ?? defaults.timeouts.flowMs,
      stepMs: autoFlow.timeouts?.stepMs ?? defaults.timeouts.stepMs,
    },
  };
}

/**
 * Resolve Telegram credentials from `ctx.config.interaction` — only meaningful
 * when `interaction.plugin === "telegram"`, in which case `interaction.config`
 * carries `botToken`/`chatId` (see `src/interaction/plugins/telegram.ts`).
 * Falls back to the same env vars the telegram interaction plugin itself uses.
 */
export function telegramCreds(config: unknown): { token: string; chatId: string } | null {
  const interaction = (config as { interaction?: { plugin?: string; config?: { botToken?: string; chatId?: string } } })
    ?.interaction;
  const tg = interaction?.plugin === "telegram" ? (interaction.config ?? {}) : {};
  const token = tg.botToken ?? process.env.NAX_TELEGRAM_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
  const chatId = tg.chatId ?? process.env.NAX_TELEGRAM_CHAT_ID ?? null;
  return token && chatId ? { token, chatId } : null;
}

/** Whether Telegram is configured for escalation notifications. */
export function isTelegramConfigured(config: unknown): boolean {
  return telegramCreds(config) !== null;
}
