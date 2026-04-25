export type AdapterInteraction =
  | { kind: "context-tool"; name: string; input?: unknown; error?: string }
  | { kind: "question"; text: string };

export interface AdapterInteractionResponse {
  answer: string;
}

export interface InteractionHandler {
  onInteraction(request: AdapterInteraction): Promise<AdapterInteractionResponse | null>;
}

export const NO_OP_INTERACTION_HANDLER: InteractionHandler = {
  async onInteraction() {
    return null;
  },
};
