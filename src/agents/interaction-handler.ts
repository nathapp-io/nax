import { NO_OP_INTERACTION_HANDLER as RUNTIME_NO_OP_INTERACTION_HANDLER } from "../runtime/no-op-interaction-handler";

export type AdapterInteraction =
  | { kind: "context-tool"; name: string; input?: unknown; error?: string }
  | { kind: "question"; text: string };

export interface AdapterInteractionResponse {
  answer: string;
}

export interface InteractionHandler {
  onInteraction(request: AdapterInteraction): Promise<AdapterInteractionResponse | null>;
}

export const NO_OP_INTERACTION_HANDLER: InteractionHandler = RUNTIME_NO_OP_INTERACTION_HANDLER;
