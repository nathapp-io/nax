/**
 * US-003 — the refine path's structure repair runs first.
 *
 * Unit tests for the spec-structure repair in `planRefineOp.hopBody`
 * (src/operations/plan-refine.ts).
 *
 * Refine fires its conditional repair turns in one session. The structure
 * repair must come first: out-of-scope preservation and spec-drift auditing both
 * assume the PRD's story ids already match the spec's, and the continuation
 * tells the planner which iteration rules are binding for it.
 *
 * Split out of `plan-refine.test.ts` by concern (that file is at the 800-line
 * cap), not by ticket.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makePRD, makeStory } from "@test/helpers";
import type { TurnResult } from "@/agents/types";
import type { PlanRefineInput } from "@/operations";
import { _planRefineDeps, planRefineOp } from "@/operations";
import type { HopBodyContext } from "@/operations/types";

const OUTPUT_PATH = "/tmp/plan-refine-structure-prd.json";
const INITIAL_PROMPT = "refine prompt";

const SPEC = `# Checkout flow

## Out of Scope

- An interactive Ink TUI

## Stories

1. **US-001: Core** — \`Workdir: packages/core\` — no dependencies
2. **US-002: API** — \`Workdir: apps/api\` — depends on US-001
`;

/** A spec that declares no story at all. */
const SPEC_WITHOUT_STORIES = "# Checkout flow\n\n## Goal\n\nMake checkout faster.\n";

const INPUT: PlanRefineInput = {
  specContent: SPEC,
  codebaseContext: "",
  featureName: "checkout-flow",
  branchName: "feat/checkout",
  outputPath: OUTPUT_PATH,
};

/** A draft that keeps US-001, drops spec story US-002 and the spec's exclusion. */
function draftJson(): string {
  return JSON.stringify(
    makePRD({
      feature: "checkout-flow",
      branchName: "feat/checkout",
      userStories: [
        makeStory({
          id: "US-001",
          title: "Core",
          description: "core",
          acceptanceCriteria: ["When the cart is empty, checkout throws"],
          workdir: "packages/core",
          dependencies: [],
          routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "stub", reasoning: "stub" },
        }),
      ],
    }),
  );
}

function turn(output: string, cost: number): TurnResult {
  return { output, estimatedCostUsd: cost, internalRoundTrips: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
}

function makeCtx(input: PlanRefineInput = INPUT) {
  let call = 0;
  const send = mock(async (_prompt: string) => {
    call += 1;
    return turn(`send-${call}`, 1);
  });
  const sendWithParseRetry = mock(async (_prompt: string) => turn("seed", 2));
  const ctx: HopBodyContext<PlanRefineInput> = { input, send, sendWithParseRetry };
  return { ctx, send, sendWithParseRetry };
}

describe("planRefineOp.hopBody — spec structure repair (US-003)", () => {
  const origReadFile = _planRefineDeps.readFile;
  afterEach(() => {
    _planRefineDeps.readFile = origReadFile;
    mock.restore();
  });

  test("AC12: sends the refine continuation, then the structure repair, then the out-of-scope repair", async () => {
    _planRefineDeps.readFile = async () => draftJson();
    const { ctx, send, sendWithParseRetry } = makeCtx();
    assertDefined(planRefineOp.hopBody, "planRefineOp.hopBody");

    const result = await planRefineOp.hopBody(INITIAL_PROMPT, ctx);

    expect(sendWithParseRetry).toHaveBeenCalledTimes(1);
    expect(sendWithParseRetry).toHaveBeenCalledWith(INITIAL_PROMPT);
    expect(send).toHaveBeenCalledTimes(3);

    const prompts = send.mock.calls.map((call) => call[0] ?? "");
    expect(prompts[0] ?? "").toContain("second turn of a refine pass");
    expect(prompts[1] ?? "").toContain("US-002: missing");
    expect(prompts[1] ?? "").toContain("Your PRD does not match the story structure the spec declares.");
    expect(prompts[2] ?? "").toContain("An interactive Ink TUI");
    expect(result.output).toBe("send-3");
  });

  test("AC13: the refine continuation carries the binding dependency rule when the spec declares stories", async () => {
    _planRefineDeps.readFile = async () => draftJson();
    const { ctx, send } = makeCtx();
    assertDefined(planRefineOp.hopBody, "planRefineOp.hopBody");

    await planRefineOp.hopBody(INITIAL_PROMPT, ctx);

    const prompts = send.mock.calls.map((call) => call[0] ?? "");
    expect(prompts[0] ?? "").toContain("Never add or remove a dependency of a story the Binding Story Structure lists");
  });

  test("AC13 boundary: a spec that declares no stories keeps the plain continuation", async () => {
    _planRefineDeps.readFile = async () => null;
    const { ctx, send } = makeCtx({ ...INPUT, specContent: SPEC_WITHOUT_STORIES });
    assertDefined(planRefineOp.hopBody, "planRefineOp.hopBody");

    await planRefineOp.hopBody(INITIAL_PROMPT, ctx);

    expect(send).toHaveBeenCalledTimes(1); // the continuation only
    const prompts = send.mock.calls.map((call) => call[0] ?? "");
    expect(prompts[0] ?? "").not.toContain("Never add or remove a dependency of a story");
  });
});
