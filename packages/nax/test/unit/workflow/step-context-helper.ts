import { makeMockCallContext, makeNaxConfig, makeTestStory } from "@test/helpers";
import { resolveWorkflowConfig } from "@/config";
import type { StepContext } from "@/workflow/step-context";

/** Typed StepContext builder: required fields get inert defaults, overrides win. */
export function makeStepContext(overrides: Partial<StepContext> = {}): StepContext {
  const config = makeNaxConfig();
  return {
    callCtx: makeMockCallContext(),
    story: makeTestStory({ id: "US-001" }),
    config,
    workflow: resolveWorkflowConfig(config),
    tierOrder: [],
    feature: "f",
    projectDir: "/repo",
    workdir: "/repo",
    runDir: "/repo/run",
    storyDir: "/repo/run/US-001",
    briefPath: "/repo/run/US-001/brief.md",
    reportPath: "/repo/run/US-001/report.md",
    base: "abc",
    dryRun: false,
    ...overrides,
  };
}
