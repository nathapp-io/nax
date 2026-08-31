import type { ProtocolBackends } from "../registry.ts";

export const OPENAI_COMPLETIONS_BACKENDS: ProtocolBackends = {
  pi: async () => {
    const { createOpenAiCompletionsPi } = await import("./backend-pi.ts");
    const { createPiClient } = await import("../pi-client.ts");
    return createOpenAiCompletionsPi({ client: await createPiClient("openai-completions") });
  },
};
