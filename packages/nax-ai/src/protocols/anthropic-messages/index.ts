/**
 * Backend registration for the Anthropic Messages protocol.
 *
 * The pi-ai import is lazy so the SDK is not loaded until this protocol is
 * actually used — the property that keeps nax-ai's import cost at tens of
 * milliseconds despite an 85 MB dependency tree.
 */

import type { ProtocolBackends } from "../registry.ts";

export const ANTHROPIC_MESSAGES_BACKENDS: ProtocolBackends = {
  pi: async () => {
    const { createAnthropicMessagesPi } = await import("./backend-pi.ts");
    const { createPiClient } = await import("../pi-client.ts");
    return createAnthropicMessagesPi({ client: await createPiClient("anthropic-messages") });
  },
};
