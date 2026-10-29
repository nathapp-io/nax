import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import type { InteractionChain, initInteractionChain } from "@/interaction";
import { getLogger } from "@/logger";

/** A failed chat channel must not prevent the existing bot step from running. */
export async function initBotInteractionChain(options: {
  input: { readonly chatAsksDir?: string; readonly chatAskSecret?: Uint8Array };
  config: NaxConfig;
  init: typeof initInteractionChain;
}): Promise<InteractionChain | null> {
  const { input, config, init } = options;
  if (input.chatAsksDir === undefined) return null;
  try {
    return await init(config, true, { chatAsksDir: input.chatAsksDir, chatAskSecret: input.chatAskSecret });
  } catch (error) {
    getLogger().warn("bot", "Could not initialize chat asks; continuing without interaction chain", {
      chatAsksDir: input.chatAsksDir,
      error: errorMessage(error),
    });
    return null;
  }
}
