/**
 * stage-config.ts — reachability guard (nax#1743).
 *
 * `STAGE_CONTEXT_MAP` can declare a stage key that no assembly site ever
 * selects. When that key carries `pullToolNames`, the declared pull tools
 * can never reach an agent — the config is dead weight that looks live.
 *
 * This test builds the actual reachable stage-key set by driving the two
 * selector functions (`executionContextStage`, `contextStageForOp`) over
 * their full input domains — never by hardcoding the stage strings they
 * return — and asserts every key with a non-empty `pullToolNames` is in
 * that set (plus the always-live "context" key, the third assembly site).
 *
 * Not every key in STAGE_CONTEXT_MAP is checked: the declared-but-unassembled
 * keys autofix, verify, review, acceptance, plan, route and debate carry no
 * pull tools and are intentionally aspirational — see the reachability comment
 * above STAGE_CONTEXT_MAP. `review-dialogue` used to be the one exception —
 * it declared pull tools AND was unassembled — but nax#1758 dropped its
 * `pullToolNames` (no dispatch seam exists to wire; `query_feature_context`
 * is already available to the two review stages that ARE assembled). Every
 * pull-tool-declaring stage in STAGE_CONTEXT_MAP is now reachable, with no
 * exemptions — this guard fails outright if that regresses.
 */

import { describe, expect, test } from "bun:test";
import { VALID_TEST_STRATEGIES } from "@/config";
import { contextStageForOp, executionContextStage, STAGE_CONTEXT_MAP, type StageContextConfig } from "@/context/engine";

/**
 * `STAGE_CONTEXT_MAP` is declared with `satisfies`, so its value type is a
 * union of per-entry literal shapes and `pullToolNames` is absent from the
 * entries that do not declare it. Widen to the declared interface for the
 * uniform reads below — this loses key literals, which this file does not need.
 */
const STAGE_CONFIGS: Record<string, StageContextConfig> = STAGE_CONTEXT_MAP;

/** Op names THREE_SESSION_STAGE_MAP / UNCONDITIONAL_STAGE_MAP / RECTIFICATION_STAGE_MAP key off (phase-stage-map.ts). */
const KNOWN_OP_NAMES = [
  "test-writer",
  "implementer",
  "verifier",
  "semantic-review",
  "adversarial-review",
  "rectify",
  "autofix-implementer",
  "full-suite-rectify",
  "repo-scoped-test-fix",
];

/** Builds the set of stage keys reachable from a live assembly site today. */
function buildReachableStageKeys(): Set<string> {
  const reachable = new Set<string>();

  // Site 1: src/pipeline/stages/context.ts always assembles "context".
  reachable.add("context");

  // Site 2: src/pipeline/stages/prompt.ts, via executionContextStage.
  reachable.add(executionContextStage({ isBatch: true }));
  reachable.add(executionContextStage({ isBatch: false }));
  for (const testStrategy of VALID_TEST_STRATEGIES) {
    reachable.add(executionContextStage({ isBatch: false, testStrategy }));
    reachable.add(executionContextStage({ isBatch: true, testStrategy }));
  }

  // Site 3: src/execution/story-orchestrator/run-phase.ts, via contextStageForOp.
  for (const opName of KNOWN_OP_NAMES) {
    for (const isThreeSession of [true, false]) {
      for (const inRectification of [true, false]) {
        const stage = contextStageForOp(opName, { isThreeSession, inRectification });
        if (stage) reachable.add(stage);
      }
    }
  }

  return reachable;
}

describe("STAGE_CONTEXT_MAP — reachability guard (nax#1743, nax#1758)", () => {
  const reachable = buildReachableStageKeys();

  const stagesWithPullTools = Object.entries(STAGE_CONFIGS)
    .filter(([, config]) => (config.pullToolNames?.length ?? 0) > 0)
    .map(([stage]) => stage);

  test("at least one stage declares pull tools (sanity check the fixture isn't vacuous)", () => {
    expect(stagesWithPullTools.length).toBeGreaterThan(0);
  });

  test.each(stagesWithPullTools)(
    "%s declares pullToolNames and is reachable from a live assembly site — otherwise its pull tools can never reach an agent",
    (stage) => {
      expect(reachable.has(stage)).toBe(true);
    },
  );
});
