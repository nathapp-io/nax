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
import { CHOICE_MAX_QUESTIONS } from "#src/session/choice-questions";

export const ASK_HUMAN_TOOL_NAME = "ask_human";

/**
 * US-002: how many options one choice question may offer. Native's own limit —
 * the shared contract takes it as a parameter, so it stays off the `.` entry
 * (a host that renders choices picks its own number).
 */
export const NATIVE_CHOICE_MAX_OPTIONS = 8;

/** The one question shape the model is told to send; the parser is the gate. */
const QUESTION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "The question itself, in one sentence." },
    header: {
      type: "string",
      description: "Short tab label (at most 16 characters). Defaults to Q1, Q2, ... when omitted.",
    },
    options: {
      type: "array",
      minItems: 2,
      maxItems: NATIVE_CHOICE_MAX_OPTIONS,
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "The option the person picks." },
          description: { type: "string", description: "One line saying what the option means." },
        },
        required: ["label"],
      },
    },
    multiSelect: {
      type: "boolean",
      description: "True when several answers may be picked; absent means one.",
    },
  },
  required: ["question", "options"],
} satisfies Record<string, unknown>;

export const askHumanToolDefinition: ToolDefinition = {
  name: ASK_HUMAN_TOOL_NAME,
  description:
    "Ask the human operator a question and wait for their reply. Use only when genuinely blocked: the budget is small and each call costs a round trip.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The question to put to the operator, or the context line above the questions.",
      },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: CHOICE_MAX_QUESTIONS,
        description:
          "Optional choice questions. Each question takes 2 to 8 options; multiSelect allows several answers; the person can always type their own answer instead of picking one.",
        items: QUESTION_ITEM_SCHEMA,
      },
    },
    required: ["text"],
  },
};
