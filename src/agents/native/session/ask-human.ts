/**
 * The native human-Q&A channel.
 *
 * `AdapterInteraction` has always declared `{ kind: "question" }`, but the
 * native loop routed only context-tools and coding-tools, so on native the
 * operator could never be asked anything — while `agent.maxInteractionTurns`,
 * the budget that names exactly this, was being spent as a round-trip cap.
 *
 * A declared tool rather than acpx's output parsing (acp/adapter.ts): the
 * native protocol has a structured tool channel, and parsing prose for a
 * question when a structured call is available is the weaker mechanism.
 */

import type { ToolDefinition } from "@nathapp/nax-ai";

export const ASK_HUMAN_TOOL_NAME = "ask_human";

export const askHumanToolDefinition: ToolDefinition = {
  name: ASK_HUMAN_TOOL_NAME,
  description:
    "Ask the human operator a question and wait for their reply. Use only when genuinely blocked: the budget is small and each call costs a round trip.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "The question to put to the operator." } },
    required: ["text"],
  },
};
