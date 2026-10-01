/**
 * US-003 — the interactive planner's one structure repair turn.
 *
 * Unit tests for the spec-structure self-heal turn wired into
 * `planInteractiveOp.hopBody` (src/operations/plan.ts).
 *
 * The step's own detection logic is covered in `plan-structure-heal.test.ts`;
 * these cover the wiring: the seed turn, at most one structure repair per plan,
 * the cost roll-up, and the no-op path for a spec that declares no stories.
 *
 * Split out of `plan-interactive.test.ts` by concern (that file is at its size
 * target), not by ticket.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makePRD, makeStory } from "@test/helpers";
import type { TurnResult } from "@/agents/types";
import type { PlanInteractiveInput } from "@/operations";
import { _planInteractiveDeps, planInteractiveOp } from "@/operations";
import type { HopBodyContext } from "@/operations/types";
import type { UserStory } from "@/prd/types";

const OUTPUT_PATH = "/tmp/plan-interactive-prd.json";
const INITIAL_PROMPT = "draft prompt";

const WORKDIRS: Record<string, string> = {
  "US-001": "packages/core",
  "US-002": "apps/api",
  "US-003": "apps/web",
  "US-004": "apps/cli",
  "US-005": "apps/docs",
};

const SPEC = `# Feature

## Stories

1. **US-001: Core** — \`Workdir: packages/core\` — no dependencies
2. **US-002: API** — \`Workdir: apps/api\` — depends on US-001
3. **US-003: Web** — \`Workdir: apps/web\` — depends on US-002
4. **US-004: CLI** — \`Workdir: apps/cli\` — depends on US-003
5. **US-005: Docs** — \`Workdir: apps/docs\` — depends on US-004
`;

/** A spec that declares no story at all. */
const SPEC_WITHOUT_STORIES = "# Feature\n\n## Goal\n\nShip it faster.\n";

/** The draft a planner produces when it folds US-004 into US-005. */
const DRAFT_OMITTING_US_004 = ["US-001", "US-002", "US-003", "US-005"];

const INPUT: PlanInteractiveInput = {
  specContent: SPEC,
  codebaseContext: "",
  featureName: "feature",
  branchName: "feat/feature",
  outputPath: OUTPUT_PATH,
};

/** A parseable draft PRD carrying the given stories, each depending on the one before it. */
function draftJson(ids: readonly string[]): string {
  const stories: UserStory[] = ids.map((id, index) => {
    const previous = ids[index - 1];
    return makeStory({
      id,
      title: `${id} story`,
      description: `${id} story`,
      acceptanceCriteria: ["When the CLI runs, it writes the report"],
      workdir: WORKDIRS[id],
      dependencies: previous === undefined ? [] : [previous],
      routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "stub", reasoning: "stub" },
    });
  });
  return JSON.stringify(makePRD({ feature: "feature", branchName: "feat/feature", userStories: stories }));
}

function turn(output: string, cost: number): TurnResult {
  return { output, estimatedCostUsd: cost, internalRoundTrips: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
}

function makeCtx(seedCost = 0.2, repairCost = 0.1) {
  const sendWithParseRetry = mock(async (_prompt: string) => turn("draft", seedCost));
  const send = mock(async (_prompt: string) => turn("repaired", repairCost));
  const ctx: HopBodyContext<PlanInteractiveInput> = { input: INPUT, send, sendWithParseRetry };
  return { ctx, send, sendWithParseRetry };
}

async function runHopBody(input: PlanInteractiveInput, ctx: HopBodyContext<PlanInteractiveInput>) {
  assertDefined(planInteractiveOp.hopBody, "planInteractiveOp.hopBody");
  return planInteractiveOp.hopBody(INITIAL_PROMPT, { ...ctx, input });
}

describe("planInteractiveOp.hopBody — spec structure self-heal (US-003)", () => {
  const origReadFile = _planInteractiveDeps.readFile;
  afterEach(() => {
    _planInteractiveDeps.readFile = origReadFile;
    mock.restore();
  });

  test("AC10: seeds with sendWithParseRetry, then sends the structure repair exactly once", async () => {
    _planInteractiveDeps.readFile = async (path: string) =>
      path === OUTPUT_PATH ? draftJson(DRAFT_OMITTING_US_004) : null;
    const { ctx, send, sendWithParseRetry } = makeCtx();

    const result = await runHopBody(INPUT, ctx);

    expect(sendWithParseRetry).toHaveBeenCalledTimes(1);
    expect(sendWithParseRetry).toHaveBeenCalledWith(INITIAL_PROMPT);
    expect(send).toHaveBeenCalledTimes(1);
    const repairPrompt = send.mock.calls[0]?.[0] ?? "";
    expect(repairPrompt).toContain("US-004: missing");
    expect(repairPrompt).toContain("Your PRD does not match the story structure the spec declares.");
    expect(repairPrompt).toContain(OUTPUT_PATH);
    expect(result.output).toBe("repaired");
  });

  test("AC11: a spec that declares no story ids sends no corrective turn and returns the seed turn", async () => {
    _planInteractiveDeps.readFile = async () => draftJson(["US-001"]);
    const { ctx, send, sendWithParseRetry } = makeCtx();

    const result = await runHopBody({ ...INPUT, specContent: SPEC_WITHOUT_STORIES }, ctx);

    expect(sendWithParseRetry).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(result.output).toBe("draft");
    expect(result.estimatedCostUsd).toBeCloseTo(0.2, 10);
  });

  test("AC14: a draft still omitting US-004 after the repair gets no second structure repair", async () => {
    // The repair turn changes nothing on disk — the draft read back is unchanged.
    _planInteractiveDeps.readFile = async () => draftJson(DRAFT_OMITTING_US_004);
    const { ctx, send } = makeCtx();

    await runHopBody(INPUT, ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0] ?? "").toContain("US-004: missing");
  });

  test("AC15: accumulates the seed and repair turn costs onto the returned turn", async () => {
    _planInteractiveDeps.readFile = async () => draftJson(DRAFT_OMITTING_US_004);
    const { ctx } = makeCtx(0.2, 0.1);

    const result = await runHopBody(INPUT, ctx);

    expect(result.output).toBe("repaired");
    // 0.2 + 0.1 is 0.30000000000000004 in binary floating point.
    expect(result.estimatedCostUsd).toBeCloseTo(0.3, 10);
  });
});
