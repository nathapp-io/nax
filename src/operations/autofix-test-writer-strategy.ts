import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { PipelineContext } from "../pipeline/types";
import type { AutofixTestWriterInput, AutofixTestWriterOutput } from "./autofix-test-writer";

export function makeAutofixTestWriterStrategy(
  _ctx: PipelineContext,
): FixStrategy<Finding, AutofixTestWriterInput, AutofixTestWriterOutput, AutofixConfig> {
  return {
    name: "",
    appliesTo: () => null as unknown as boolean,
    fixOp: { kind: "run", name: "" } as any,
    buildInput: () => null as any,
    maxAttempts: 0,
    coRun: "exclusive",
  };
}
