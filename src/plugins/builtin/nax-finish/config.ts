/**
 * nax-finish Plugin — Config Readers
 *
 * Loose readers over `ctx.config.finish.autoFlow` (schema: `src/config/schemas.ts`)
 * and `ctx.config.interaction` (schema: `src/config/schemas-infra.ts`), mirroring
 * the `getAutoPrConfig` pattern in `src/plugins/builtin/auto-pr/index.ts`.
 */

interface FinishAutoFlowConfig {
  enabled: boolean;
  flowPath: string;
  defaultAgent: string | null;
  reviewers: { spec: string | null; quality: string | null };
  escalate: { telegram: boolean };
}

const DEFAULT_FINISH_AUTO_FLOW_CONFIG: FinishAutoFlowConfig = {
  enabled: false,
  flowPath: "flows/nax-finish/nax-finish.flow.ts",
  defaultAgent: null,
  reviewers: { spec: null, quality: null },
  escalate: { telegram: true },
};

/** Read the loose `finish.autoFlow` block from `ctx.config`, applying schema defaults when absent. */
export function getFinishAutoFlowConfig(ctx: { config?: unknown }): FinishAutoFlowConfig {
  const cfg = ctx.config as Record<string, unknown> | undefined;
  const finish = cfg?.finish as { autoFlow?: Partial<FinishAutoFlowConfig> } | undefined;
  const autoFlow = finish?.autoFlow;
  if (!autoFlow) return DEFAULT_FINISH_AUTO_FLOW_CONFIG;
  return {
    enabled: autoFlow.enabled === true,
    flowPath: autoFlow.flowPath ?? DEFAULT_FINISH_AUTO_FLOW_CONFIG.flowPath,
    defaultAgent: autoFlow.defaultAgent ?? null,
    reviewers: {
      spec: autoFlow.reviewers?.spec ?? null,
      quality: autoFlow.reviewers?.quality ?? null,
    },
    escalate: { telegram: autoFlow.escalate?.telegram !== false },
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
