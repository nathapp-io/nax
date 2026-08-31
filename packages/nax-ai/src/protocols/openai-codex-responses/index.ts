import type { ProtocolBackends } from "../registry.ts";

export const OPENAI_CODEX_RESPONSES_BACKENDS: ProtocolBackends = {
  pi: async () => {
    const { createOpenAiCodexResponsesPi } = await import("./backend-pi.ts");
    const { createPiClient } = await import("../pi-client.ts");
    return createOpenAiCodexResponsesPi({ client: await createPiClient("openai-codex-responses") });
  },
};
