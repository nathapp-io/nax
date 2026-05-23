import type { AutofixConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import type { PipelineContext } from "../pipeline/types";
import type { AutofixImplementerInput, AutofixImplementerOutput } from "./autofix-implementer";

export function makeAutofixImplementerStrategy(
  _ctx: PipelineContext,
): FixStrategy<Finding, AutofixImplementerInput, AutofixImplementerOutput, AutofixConfig> {
  return {
    name: "",
    appliesTo: () => null as unknown as boolean,
    fixOp: { kind: "run", name: "" } as any,
    buildInput: () => null as any,
    maxAttempts: 0,
    coRun: "exclusive",
  };
}
