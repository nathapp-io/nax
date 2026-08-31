import type { ProtocolBackends } from "../registry.ts";

export const OPENAI_RESPONSES_BACKENDS: ProtocolBackends = {
  pi: async () => {
    const { createOpenAiResponsesPi } = await import("./backend-pi.ts");
    const { createPiClient } = await import("../pi-client.ts");
    return createOpenAiResponsesPi({ client: await createPiClient("openai-responses") });
  },
};
