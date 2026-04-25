import type { Complexity, ModelTier } from "../config";
import { routingConfigSelector } from "../config";
import { NaxError } from "../errors";
import type { UserStory } from "../prd";
import { ROUTING_INSTRUCTIONS } from "../routing";
import { parseLLMJson } from "../utils/llm-json";
import type { BuildContext, CompleteOperation } from "./types";

export interface ClassifyRouteInput extends Pick<UserStory, "title" | "description" | "acceptanceCriteria" | "tags"> {}

export interface ClassifyRouteOutput {
  complexity: Complexity;
  modelTier: ModelTier;
  reasoning: string;
}

type RoutingConfig = ReturnType<typeof routingConfigSelector.select>;

const VALID_COMPLEXITY = new Set<string>(["simple", "medium", "complex", "expert"]);
const VALID_TIERS = new Set<string>(["fast", "balanced", "powerful"]);

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
  parse(output: string): ClassifyRouteOutput {
    const raw = parseLLMJson<Record<string, unknown>>(output);
    if (
      !VALID_COMPLEXITY.has(raw.complexity as string) ||
      !VALID_TIERS.has(raw.modelTier as string) ||
      typeof raw.reasoning !== "string"
    ) {
      throw new NaxError(
        `classify-route: invalid response — ${JSON.stringify(raw)}`,
        "CLASSIFY_ROUTE_INVALID_RESPONSE",
        { stage: "run", parsed: raw },
      );
    }
    return raw as unknown as ClassifyRouteOutput;
  },
};
