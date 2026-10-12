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
    runDir: "/out/workflow/f/r1",
    featureDir: "/out/workflow/f",
    prdPath: "/repo/.nax/features/f/prd.json",
    reportPath: "/out/workflow/f/r1/feature-report.md",
    packageDirs: [],
    dryRun: false,
    ...overrides,
  };
}
