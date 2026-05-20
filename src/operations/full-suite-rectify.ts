import type { TddConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import { RectifierPromptBuilder } from "../prompts";
import type { ImplementerInput, ImplementerOutput } from "./implement";
import { implementerOp } from "./implement";

export const fullSuiteRectifyStrategy: FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> = {
  name: "full-suite-rectify",
  appliesTo: (finding) => finding.source === "test-runner" && finding.category === "failed-test",
  fixOp: implementerOp,
  buildInput: (findings, _iterations, ctx) => ({
    story: (ctx as unknown as { story: ImplementerInput["story"] }).story,
    contextMarkdown: RectifierPromptBuilder.failingTestContext(findings),
  }),
  extractApplied: (_output, _input) => ({ targetFiles: [], summary: "Fixed failing tests" }),
  maxAttempts: 3,
  coRun: "exclusive",
};
