import { resolveWorkflowConfig } from "@/config";
import type { FeatureContext } from "@/workflow/feature-context";
import { makeMockCallContext } from "./call-context";
import { makeNaxConfig } from "./mock-nax-config";
import { makeTestPRD } from "./pipeline-context";

/** Typed FeatureContext builder: required fields get inert defaults, overrides win. */
export function makeFeatureContext(overrides: Partial<FeatureContext> = {}): FeatureContext {
  const config = makeNaxConfig();
  return {
    callCtx: makeMockCallContext(),
    config,
    workflow: resolveWorkflowConfig(config),
    prd: makeTestPRD(),
    feature: "f",
    projectDir: "/repo",
    branch: "feat/x",
    runId: "r1",
    outputDir: "/out",
    runDir: "/repo/.nax/features/f/workflow/r1",
    featureDir: "/repo/.nax/features/f/workflow",
    prdPath: "/repo/.nax/features/f/prd.json",
    reportPath: "/repo/.nax/features/f/workflow/r1/feature-report.md",
    packageDirs: [],
    dryRun: false,
    ...overrides,
  };
}
