/**
 * US-003 — the spec structure self-heal step.
 *
 * Unit tests for `specStructureSelfHealStep` (src/operations/plan-structure-heal.ts).
 *
 * The step is the one-turn guard both planning ops share: it reads the draft
 * PRD the previous turn wrote to disk, compares it against the story structure
 * the spec declares, and issues exactly one corrective prompt when the two
 * diverge — nothing at all when the file is absent, unparseable, or the draft
 * already matches.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assertDefined, makePRD, makeStory } from "@test/helpers";
import type { TurnResult } from "@/agents/types";
import { specStructureSelfHealStep } from "@/operations/plan-structure-heal";
import type { HopBodyContext } from "@/operations/types";
import type { UserStory } from "@/prd/types";
import { PlanPromptBuilder } from "@/prompts";

/** What the step reads off a planning op's input. */
interface HealInput {
  specContent: string;
  featureName: string;
  branchName: string;
  outputPath: string;
}

const OUTPUT_PATH = "/tmp/plan-structure-heal-prd.json";

/** The structure the spec declares: a four-story chain, one workdir per story. */
const DECLARED: readonly { id: string; workdir: string; dependsOn: readonly string[] }[] = [
  { id: "US-001", workdir: "packages/core", dependsOn: [] },
  { id: "US-002", workdir: "apps/api", dependsOn: ["US-001"] },
  { id: "US-003", workdir: "apps/web", dependsOn: ["US-002"] },
  { id: "US-004", workdir: "apps/cli", dependsOn: ["US-003"] },
];

const SPEC = `# Feature

## Stories

1. **US-001: Core** — \`Workdir: packages/core\` — no dependencies
2. **US-002: API** — \`Workdir: apps/api\` — depends on US-001
3. **US-003: Web** — \`Workdir: apps/web\` — depends on US-002
4. **US-004: CLI** — \`Workdir: apps/cli\` — depends on US-003
`;

const INPUT: HealInput = {
  specContent: SPEC,
  featureName: "feature",
  branchName: "feat/feature",
  outputPath: OUTPUT_PATH,
};

/**
 * A parseable draft PRD carrying exactly the given declared stories, in that
 * order, each depending on the one before it in the draft — so a draft built
 * from a prefix of `DECLARED` diverges from the spec by the missing story alone.
 */
function draftJson(ids: readonly string[]): string {
  const stories: UserStory[] = ids.map((id, index) => {
    const declared = DECLARED.find((story) => story.id === id);
    assertDefined(declared, `declared structure for ${id}`);
    const previous = ids[index - 1];
    return makeStory({
      id,
      title: `${id} story`,
      description: `${id} story`,
      acceptanceCriteria: ["When the CLI runs, it writes the report"],
      workdir: declared.workdir,
      dependencies: previous === undefined ? [] : [previous],
      routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "stub", reasoning: "stub" },
    });
  });
  return JSON.stringify(makePRD({ feature: "feature", branchName: "feat/feature", userStories: stories }));
}

function turn(output: string, cost: number): TurnResult {
  return { output, estimatedCostUsd: cost, internalRoundTrips: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
}

function makeCtx() {
  const send = mock(async (_prompt: string) => turn("repaired", 1));
  const ctx: HopBodyContext<HealInput> = { input: INPUT, send, sendWithParseRetry: send };
  return { ctx, send };
}

describe("specStructureSelfHealStep (US-003)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("AC8: sends exactly one corrective turn whose prompt is the buildSpecStructureRepair output", async () => {
    const readFile = mock(async (_path: string) => draftJson(["US-001", "US-002", "US-003"]));
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildSpecStructureRepair").mockReturnValue(
      "STRUCTURE-REPAIR",
    );
    const { ctx, send } = makeCtx();

    const step = specStructureSelfHealStep<HealInput>(new PlanPromptBuilder(), readFile);
    const result = await step.run(ctx);

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(OUTPUT_PATH);
    expect(repairSpy).toHaveBeenCalledTimes(1);
    const repairCall = repairSpy.mock.calls[0];
    assertDefined(repairCall, "buildSpecStructureRepair call");
    const [violations, outputFilePath] = repairCall;
    expect(outputFilePath).toBe(OUTPUT_PATH);
    // The draft matches the spec everywhere except the story it dropped.
    expect(violations).toEqual([{ kind: "missing-story", storyId: "US-004" }]);
    // The turn the step sends carries the repair prompt the builder returned.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe("STRUCTURE-REPAIR");
    expect(result?.output).toBe("repaired");
  });

  test("AC9: sends nothing when the draft file is absent", async () => {
    const readFile = mock(async (_path: string) => null);
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildSpecStructureRepair");
    const { ctx, send } = makeCtx();

    const step = specStructureSelfHealStep<HealInput>(new PlanPromptBuilder(), readFile);
    const result = await step.run(ctx);

    expect(send).not.toHaveBeenCalled();
    expect(repairSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test.each([
    ["unparseable JSON", "{ not a prd"],
    ["JSON that is not a PRD", JSON.stringify({ output: "File already valid." })],
    ["a PRD with no stories", JSON.stringify({ project: "p", userStories: [] })],
  ])("AC9: sends nothing when the draft fails validatePlanOutput (%s)", async (_label, content) => {
    const readFile = mock(async (_path: string) => content);
    const { ctx, send } = makeCtx();

    const step = specStructureSelfHealStep<HealInput>(new PlanPromptBuilder(), readFile);
    const result = await step.run(ctx);

    expect(send).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test("AC8 boundary: sends nothing when the draft already matches the declared structure", async () => {
    const readFile = mock(async (_path: string) => draftJson(["US-001", "US-002", "US-003", "US-004"]));
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildSpecStructureRepair");
    const { ctx, send } = makeCtx();

    const step = specStructureSelfHealStep<HealInput>(new PlanPromptBuilder(), readFile);
    const result = await step.run(ctx);

    expect(send).not.toHaveBeenCalled();
    expect(repairSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
