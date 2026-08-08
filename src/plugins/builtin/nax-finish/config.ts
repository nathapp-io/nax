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

import { resolveDefaultAgent } from "@/agents";
import { finishConfigSelector } from "@/config";
import type { NaxConfig } from "@/config/types";

export interface FinishAutoFlowSettings {
  enabled: boolean;
  flowPath: string;
  /** Never null — see resolveFlowAgent. */
  defaultAgent: string;
  /** acpx `--model`; null passes no flag at all. Opt-in — see the schema. */
  model: string | null;
  narrative: boolean;
  /** PR/MR body composition — see `finish.autoFlow.prBody` in the schema. */
  prBody: { template: "merge" | "strict" | "ignore"; sectionMap: Record<string, string> };
  reviewers: { spec: string | null; quality: string | null; narrative: string | null };
  escalate: { telegram: boolean };
  notify: { mode: "escalation" | "always" | "off" };
  timeouts: { acceptanceMs: number; gateMs: number; flowMs: number; stepMs: number | null };
}

/**
 * Defaults mirroring `finish.autoFlow` in `src/config/schemas.ts`. They apply
 * only when the plugin is handed a config carrying no `finish` block at all
 * (older configs, and tests that pass a partial object).
 */
const DEFAULT_FINISH_AUTO_FLOW_CONFIG: Omit<FinishAutoFlowSettings, "defaultAgent"> = {
  enabled: false,
  flowPath: "flows/nax-finish/nax-finish.flow.ts",
  model: null,
  narrative: true,
  prBody: { template: "merge", sectionMap: {} },
  reviewers: { spec: null, quality: null, narrative: null },
  escalate: { telegram: true },
  notify: { mode: "escalation" },
  timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
};

function selectFinish(config: unknown): { autoFlow?: Partial<FinishAutoFlowSettings> } | undefined {
  if (!config || typeof config !== "object") return undefined;
  return finishConfigSelector.select(config as NaxConfig)?.finish as
    | { autoFlow?: Partial<FinishAutoFlowSettings> }
    | undefined;
}

/**
 * The agent every non-review node in the flow runs on.
 *
 * `finish.autoFlow.defaultAgent` wins when set. Otherwise it is the agent the
 * run itself used — NOT null. Passing null omits `--default-agent` from the
 * `acpx flow run` argv, which silently hands the fix nodes to whatever agent
 * acpx defaults to: a profile that configured only `reviewers` ran its
 * reviewers on the intended models and every `fix_*` node on a different one.
 * `resolveDefaultAgent` is the same accessor the run uses, so the two agree.
 */
function resolveFlowAgent(config: unknown, explicit: string | null | undefined): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return resolveDefaultAgent((config ?? {}) as Parameters<typeof resolveDefaultAgent>[0]);
}

/** Read the `finish.autoFlow` slice from `ctx.config`, applying schema defaults when absent. */
export function getFinishAutoFlowConfig(ctx: { config?: unknown }): FinishAutoFlowSettings {
  const autoFlow = selectFinish(ctx.config)?.autoFlow;
  if (!autoFlow) return { ...DEFAULT_FINISH_AUTO_FLOW_CONFIG, defaultAgent: resolveFlowAgent(ctx.config, null) };
  const defaults = DEFAULT_FINISH_AUTO_FLOW_CONFIG;
  return {
    enabled: autoFlow.enabled === true,
    flowPath: autoFlow.flowPath ?? defaults.flowPath,
    defaultAgent: resolveFlowAgent(ctx.config, autoFlow.defaultAgent),
    // Deliberately NOT defaulted to config.models: `--model` is opt-in because
    // its "floor, not override" behaviour depends on acpx supporting a model on
    // agent entries. Passing one unconditionally would override the pinned
    // reviewers on a build without that support.
    model: autoFlow.model ?? null,
    // `!== false` so an older config with no `narrative` key still narrates,
    // matching the schema default rather than silently opting out.
    narrative: autoFlow.narrative !== false,
    prBody: {
      template: autoFlow.prBody?.template ?? defaults.prBody.template,
      sectionMap: autoFlow.prBody?.sectionMap ?? defaults.prBody.sectionMap,
    },
    reviewers: {
      spec: autoFlow.reviewers?.spec ?? null,
      quality: autoFlow.reviewers?.quality ?? null,
      narrative: autoFlow.reviewers?.narrative ?? null,
    },
    escalate: { telegram: autoFlow.escalate?.telegram !== false },
    notify: { mode: autoFlow.notify?.mode ?? defaults.notify.mode },
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
