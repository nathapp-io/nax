/**
 * Interaction Check
 *
 * Starts the configured interaction plugin once, offline, and reports whether it could, so an orchestrator
 * can tell before dispatch that a run would fail at interaction-plugin init (koda #207). Every built-in
 * plugin's init() only validates config and env; the cli plugin is never started (see checkInteraction).
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import type { InteractionConfig } from "../config/selectors";
import { NaxError } from "../errors";
import { redactSecrets } from "../logger";
import { createInteractionPlugin } from "./init";
import type { InteractionPlugin } from "./types";

export const INTERACTION_INIT_FAILED = "INTERACTION_INIT_FAILED";
const MAX_CHECK_MESSAGE_CHARS = 300;
const CLI_PLUGIN_NAME = "cli";

export type InteractionCheckStatus = "ok" | "failed" | "skipped";

/** The `interaction` field of `nax config --json`. `code` and `message` are set only when `status` is "failed". */
export interface InteractionCheckReport {
  plugin: string | null;
  status: InteractionCheckStatus;
  code?: string;
  message?: string;
}

export const _interactionCheckDeps: { createPlugin: (pluginName: string) => InteractionPlugin } = {
  createPlugin: createInteractionPlugin,
};

/**
 * Report whether `config`'s interaction plugin can start here. Never throws: a failure is data.
 * The cli plugin's init opens a readline on this process's stdin, so it is never started: headless it is
 * "skipped" (initInteractionChain skips it too), on a terminal "ok" (it needs no config or env).
 */
export async function checkInteraction(
  config: InteractionConfig,
  options: { headless: boolean },
): Promise<InteractionCheckReport> {
  const interaction = config.interaction;
  if (!interaction) return { plugin: null, status: "skipped" };
  const name = interaction.plugin;
  if (name === CLI_PLUGIN_NAME) return { plugin: name, status: options.headless ? "skipped" : "ok" };
  let plugin: InteractionPlugin | undefined;
  try {
    plugin = _interactionCheckDeps.createPlugin(name);
    await plugin.init?.(interaction.config ?? {});
    return { plugin: name, status: "ok" };
  } catch (err) {
    return failedReport(name, err);
  } finally {
    await plugin?.destroy?.().catch(() => undefined);
  }
}

function failedReport(plugin: string, err: unknown): InteractionCheckReport {
  const code = err instanceof NaxError ? err.code : INTERACTION_INIT_FAILED;
  const message = redactSecrets(errorMessage(err)).slice(0, MAX_CHECK_MESSAGE_CHARS);
  return { plugin, status: "failed", code, ...(message ? { message } : {}) };
}
