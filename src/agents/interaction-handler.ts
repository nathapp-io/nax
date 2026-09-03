import { NO_OP_INTERACTION_HANDLER as RUNTIME_NO_OP_INTERACTION_HANDLER } from "../runtime/no-op-interaction-handler";

export type AdapterInteraction =
  | { kind: "context-tool"; name: string; input?: unknown; error?: string }
  | { kind: "question"; text: string }
  // Coding tools get their own kind rather than riding "context-tool": that
  // channel is the context engine's pull-tool vocabulary, with PullToolBudget
  // behind it. Routing Write through it would be a category error.
  | { kind: "coding-tool"; name: string; input?: Record<string, unknown> };

export interface AdapterInteractionResponse {
  answer: string;
  /**
   * Present only when the permission policy refused the call.
   *
   * Structural rather than a string convention: `{ answer }` alone cannot
   * distinguish "refused, and here is why" from "here is your file", and
   * conflating the two is exactly what ADR-029 section 5 forbids.
   */
  denied?: { reason: string; breach: boolean };
}

export interface InteractionHandler {
  onInteraction(request: AdapterInteraction): Promise<AdapterInteractionResponse | null>;
}

export const NO_OP_INTERACTION_HANDLER: InteractionHandler = RUNTIME_NO_OP_INTERACTION_HANDLER;
