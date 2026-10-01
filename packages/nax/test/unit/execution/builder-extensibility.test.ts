/**
 * Spec AC#10: Adding a new phase requires edits in exactly three places:
 *   (a) New op file: src/operations/<name>.ts
 *   (b) StoryOrchestratorBuilder: extends PhaseKind, CANONICAL_ORDER,
 *       collectOrderedPhases, addX overloads — single coordinated edit
 *   (c) buildPlanForStrategy: one b.addX(...) line
 *
 * This test fails if a new phase appears in src/tdd/orchestrator.ts (deleted in
 * US-005) or src/pipeline/stages/execution.ts (wrapper must stay phase-blind).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = join(import.meta.dir, "../../..");

async function readAll(glob: string): Promise<string> {
  let combined = "";
  for await (const path of new Glob(glob).scan({ cwd: REPO_ROOT, absolute: true })) {
    combined += await Bun.file(path).text();
  }
  return combined;
}

describe("AC#10 — builder extensibility constraint", () => {
  test("execution.ts contains no phase-specific dispatch (no addTestWriter/addImplementer/addVerifier calls)", async () => {
    const src = await Bun.file(join(REPO_ROOT, "src/pipeline/stages/execution.ts")).text();
    for (const sym of [
      "addTestWriter",
      "addImplementer",
      "addVerifier",
      "addGreenfieldGate",
      "addFullSuiteGate",
      "addSemanticReview",
      "addAdversarialReview",
      "addRectification",
    ]) {
      expect(
        src.includes(sym),
        `execution.ts must not call ${sym} — phase dispatch belongs in buildPlanForStrategy`,
      ).toBe(false);
    }
  });

  test("buildPlanForStrategy.ts is the only file calling phase add* methods (excluding the builder definition itself)", async () => {
    const callers = new Set<string>();
    for await (const path of new Glob("src/**/*.ts").scan({ cwd: REPO_ROOT, absolute: false })) {
      if (path === "src/execution/story-orchestrator.ts") continue; // builder owns the methods
      if (path === "src/execution/build-plan-for-strategy.ts") {
        callers.add(path);
        continue;
      }
      const src = await Bun.file(join(REPO_ROOT, path)).text();
      if (
        /\bb\.add(TestWriter|Implementer|Verifier|GreenfieldGate|FullSuiteGate|SemanticReview|AdversarialReview|Rectification)\(/.test(
          src,
        )
      ) {
        callers.add(path);
      }
    }
    expect(callers).toEqual(new Set(["src/execution/build-plan-for-strategy.ts"]));
  });

  test("legacy entry points are gone", async () => {
    expect(await Bun.file(join(REPO_ROOT, "src/tdd/orchestrator.ts")).exists()).toBe(false);
    expect(await Bun.file(join(REPO_ROOT, "src/tdd/rectification-gate.ts")).exists()).toBe(false);
    expect(await Bun.file(join(REPO_ROOT, "src/tdd/orchestrator-ctx.ts")).exists()).toBe(false);
  });

  test("grep for retired symbols returns zero matches in production source", async () => {
    // Only scan src/ — test files verifying absence are expected to reference the symbols.
    const combined = await readAll("src/**/*.ts");
    const retired = [
      ["run", "ThreeSession", "Tdd"].join(""),
      ["run", "TddSession", "ViaBuilder"].join(""),
      ["run", "FullSuite", "Gate"].join(""),
      ["Three", "Session", "TddResult"].join(""),
    ];
    for (const sym of retired) {
      expect(combined.includes(sym), `Found retired symbol in src/: ${sym}`).toBe(false);
    }
  });
});
