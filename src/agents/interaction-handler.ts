import { NO_OP_INTERACTION_HANDLER as RUNTIME_NO_OP_INTERACTION_HANDLER } from "../runtime/no-op-interaction-handler";

export type AdapterInteraction =
  | { kind: "context-tool"; name: string; input?: unknown; error?: string }
  | { kind: "question"; text: string }
  // Coding tools get their own kind rather than riding "context-tool": that
  // channel is the context engine's pull-tool vocabulary, with PullToolBudget
  // behind it. Routing Write through it would be a category error.
  | {
      kind: "coding-tool";
      name: string;
      input?: Record<string, unknown>;
      /** Turn context, for the audit ledger. Native only. */
      turnId?: string;
      roundTrips?: number;
      toolCallId?: string;
      /** Native shapes the final post-handler result at its loop chokepoint. */
      deferModelTruncation?: boolean;
    };

export interface AdapterInteractionResponse {
  answer: string;
  /** Completes deferred coding-tool audit with the final model-facing content. */
  finalizeAudit?: (content: string) => void;
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
