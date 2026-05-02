import { routingConfigSelector } from "../config";
import type { RoutingConfig } from "../config/selectors";
import type { UserStory } from "../prd";
import type { RoutingDecision } from "../routing";
import { ROUTING_INSTRUCTIONS, validateRoutingDecision } from "../routing";
import { parseBatchResponse } from "../routing/strategies/llm-parsing";
import { parseLLMJson } from "../utils/llm-json";
import type { BuildContext, CompleteOperation } from "./types";

export interface ClassifyRouteInput extends Pick<UserStory, "title" | "description" | "acceptanceCriteria" | "tags"> {}

/**
 * The op outputs a full `RoutingDecision` — the same shape the legacy
 * `classifyWithLlm` returns. There is no separate output type: the op IS a
 * RoutingDecision producer. `parse` runs the SSOT validator
 * `validateRoutingDecision` (config-aware tier check + `testStrategy` derivation).
 */
export type ClassifyRouteOutput = RoutingDecision;

const CLASSIFY_ROLE = `You are a story classifier that assigns complexity and model tier to user stories.
Respond with JSON only — no explanation text before or after.`;

export const classifyRouteOp: CompleteOperation<ClassifyRouteInput, ClassifyRouteOutput, RoutingConfig> = {
  kind: "complete",
  name: "classify-route",
  stage: "run",
  jsonMode: true,
  config: routingConfigSelector,
  build(input: ClassifyRouteInput, _ctx: BuildContext<RoutingConfig>) {
    const criteria = input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const storyBody = [
      `Title: ${input.title}`,
      `Description: ${input.description}`,
      `Acceptance Criteria:\n${criteria}`,
      `Tags: ${input.tags.join(", ")}`,
    ].join("\n");

    return {
      role: { id: "role", content: CLASSIFY_ROLE, overridable: false },
      task: { id: "task", content: `${ROUTING_INSTRUCTIONS}\n\n## Story\n\n${storyBody}`, overridable: false },
    };
  },
  parse(output: string, input: ClassifyRouteInput, ctx: BuildContext<RoutingConfig>): ClassifyRouteOutput {
    const raw = parseLLMJson<Record<string, unknown>>(output);
    return validateRoutingDecision(raw, ctx.packageView.config, input);
  },
};

// ---------------------------------------------------------------------------
// classifyRouteBatchOp — batch routing for a set of stories in one LLM call
// ---------------------------------------------------------------------------

/** Shared batch schema embedded inline — mirrors BATCH_ROUTING_SCHEMA in llm.ts */
const BATCH_ROUTING_SCHEMA_INLINE = `Respond with a JSON array — no explanation, no markdown.
Example: [{"id":"US-001","complexity":"simple","modelTier":"fast","reasoning":"<one line>"}]`;

export const classifyRouteBatchOp: CompleteOperation<UserStory[], Map<string, RoutingDecision>, RoutingConfig> = {
  kind: "complete",
  name: "classify-route-batch",
  stage: "run",
  jsonMode: true,
  config: routingConfigSelector,
  build(input: UserStory[], _ctx: BuildContext<RoutingConfig>) {
    const storyBlocks = input
      .map((story, idx) => {
        const criteria = story.acceptanceCriteria.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
        return `${idx + 1}. ${story.id}: ${story.title}\n   Description: ${story.description}\n   Acceptance Criteria:\n${criteria}\n   Tags: ${story.tags.join(", ")}`;
      })
      .join("\n\n");

    const taskContent = `${ROUTING_INSTRUCTIONS}\n\n## Stories\n\n${storyBlocks}\n\n## Output Schema\n\n${BATCH_ROUTING_SCHEMA_INLINE}`;

    return {
      role: { id: "role", content: CLASSIFY_ROLE, overridable: false },
      task: { id: "task", content: taskContent, overridable: false },
    };
  },
  parse(output: string, input: UserStory[], ctx: BuildContext<RoutingConfig>): Map<string, RoutingDecision> {
    return parseBatchResponse(output, input, ctx.packageView.config);
  },
};
