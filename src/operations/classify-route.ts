import { routingConfigSelector } from "../config/selectors";
import type { UserStory } from "../prd";
import type { BuildContext, CompleteOperation } from "./types";

export interface ClassifyRouteInput extends Pick<UserStory, "title" | "description" | "acceptanceCriteria" | "tags"> {}

export interface ClassifyRouteOutput {
  complexity: "simple" | "medium" | "complex" | "expert";
  modelTier: "fast" | "balanced" | "powerful";
  reasoning: string;
}

type RoutingConfig = ReturnType<typeof routingConfigSelector.select>;

const CLASSIFY_ROLE = `You are a story classifier that assigns complexity and model tier to user stories.
Respond with JSON only — no explanation text before or after.`;

const ROUTING_INSTRUCTIONS = `Classify the user story's complexity and select the cheapest model tier that will succeed.

## Complexity Levels
- simple: Typos, config updates, boilerplate, barrel exports, re-exports. <30 min.
- medium: Standard features, moderate logic, straightforward tests. 30-90 min.
- complex: Multi-file refactors, new subsystems, integration work. >90 min.
- expert: Security-critical, novel algorithms, complex architecture decisions.

## Rules
- Default to the CHEAPEST tier that will succeed.
- Simple barrel exports, re-exports, or index files → always simple + fast.
- Many files ≠ complex — copy-paste refactors across files are simple.
- Pure refactoring/deletion with no new behavior → simple.`;

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
    const trimmed = output
      .trim()
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/, "");
    const parsed = JSON.parse(trimmed) as ClassifyRouteOutput;
    if (!parsed.complexity || !parsed.modelTier) {
      throw new Error(`classify-route: invalid response — ${JSON.stringify(parsed)}`);
    }
    return parsed;
  },
};
