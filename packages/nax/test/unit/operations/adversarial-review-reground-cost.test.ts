/**
 * The reprompt turn of an adversarial AC-reground is billed into the returned
 * TurnResult on EVERY outcome, including the two that keep the first turn's output.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, makeTurnResult, withTempDir } from "@test/helpers";
import { type AdversarialReviewInput, adversarialReviewOp } from "@/operations/adversarial-review";
import type { HopBodyContext } from "@/operations/types";

assertDefined(adversarialReviewOp.hopBody, "adversarialReviewOp.hopBody");
const runHopBody = adversarialReviewOp.hopBody.bind(adversarialReviewOp);

const CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [] as string[],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
  acRegroundOnDrop: true,
  substantiation: { requote: false, maxRequotes: 0 },
};

const STORY = {
  id: "STORY-COST",
  title: "reground cost",
  description: "reground cost",
  acceptanceCriteria: ["auth login must not allow SQL injection attacks"],
};

// No acQuote/acIndex: filterByAcQuote drops it, which triggers the reground.
const DROPPED = {
  severity: "error",
  category: "security",
  file: "src/auth.ts",
  line: 1,
  issue: "SQL injection via rawQuery",
  suggestion: "Use parameterized queries",
};

async function regroundCost(secondOutput: string): Promise<number | undefined> {
  return withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");
    const first = JSON.stringify({ passed: false, findings: [DROPPED] });
    const result = await runHopBody("initial prompt", {
      sendWithParseRetry: mock(async () => makeTurnResult({ output: first, estimatedCostUsd: 0.1 })),
      send: mock(async () => makeTurnResult({ output: secondOutput, estimatedCostUsd: 0.2 })),
      input: { workdir, story: STORY, adversarialConfig: { ...CONFIG }, mode: "ref" },
    } satisfies HopBodyContext<AdversarialReviewInput>);
    return result.estimatedCostUsd;
  });
}

describe("adversarialReviewOp.hopBody — reground cost on first-turn-preserving outcomes", () => {
  test("parse-failed: both turns are billed", async () => {
    expect(await regroundCost("not json at all")).toBeCloseTo(0.3, 10);
  });

  test("still-dropped: both turns are billed", async () => {
    expect(await regroundCost(JSON.stringify({ passed: false, findings: [DROPPED] }))).toBeCloseTo(0.3, 10);
  });
});
