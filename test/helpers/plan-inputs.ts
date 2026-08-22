import type { NaxConfig } from "@/config";
/**
 * Mock PlanInputs factory for unit tests.
 *
 * Provides a minimal valid PlanInputs that satisfies assemblePlanInputs validation
 * without requiring a full pipeline context. Op-specific input fields (testWriter,
 * greenfieldGate, etc.) are left undefined by default — pass overrides to populate
 * the slots relevant to the test.
 */
import type { PlanInputs } from "@/execution/plan-inputs";
import type { UserStory } from "@/prd/types";
import type { ResolvedTestPatterns } from "@/test-runners";
import { makeNaxConfig } from "./mock-nax-config";
import { makeStory } from "./mock-story";

/** Minimal resolved test patterns sufficient for plan input assembly. */
function makeResolvedTestPatterns(): ResolvedTestPatterns {
  return {
    globs: ["test/**/*.test.ts"],
    regex: [/\.test\.ts$/],
    pathspec: [":(exclude)test/**/*.test.ts"],
    testDirs: ["test/unit", "test/integration"],
    resolution: "detected",
  };
}

export function makeMockPlanInputs(overrides: Partial<PlanInputs> = {}): PlanInputs {
  const story: UserStory = overrides.story ?? makeStory();
  const config: NaxConfig = overrides.config ?? makeNaxConfig();

  return {
    story,
    config,
    resolvedTestPatterns: makeResolvedTestPatterns(),
    ...overrides,
  };
}
