import type { SemanticVerdict } from "../acceptance/types";
import { acceptanceConfigSelector } from "../config";
import type { AcceptanceConfig } from "../config/selectors";
import { acceptanceDiagnoseRawArrayToFindings } from "../findings";
import type { Finding } from "../findings";
import { AcceptancePromptBuilder } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface AcceptanceDiagnoseInput {
  testOutput: string;
  testFileContent: string;
  sourceFiles: Array<{ path: string; content: string }>;
  semanticVerdicts?: SemanticVerdict[];
}

export interface AcceptanceDiagnoseOutput {
  verdict: "source_bug" | "test_bug" | "both";
  reasoning: string;
  confidence: number;
  findings?: Finding[];
}

const FALLBACK: AcceptanceDiagnoseOutput = {
  verdict: "source_bug",
  reasoning: "diagnosis failed — falling back to source fix",
  confidence: 0,
};

export const acceptanceDiagnoseOp: RunOperation<AcceptanceDiagnoseInput, AcceptanceDiagnoseOutput, AcceptanceConfig> = {
  kind: "run",
  name: "acceptance-diagnose",
  stage: "acceptance",
  session: { role: "diagnose", lifetime: "fresh" },
  config: acceptanceConfigSelector,
  timeoutMs: (_input, ctx) => ctx.config.acceptance.timeoutMs,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildDiagnosisPrompt({
      testOutput: input.testOutput,
      testFileContent: input.testFileContent,
      sourceFiles: input.sourceFiles,
      semanticVerdicts: input.semanticVerdicts,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    const raw = tryParseLLMJson<Record<string, unknown>>(output);
    if (
      raw &&
      typeof raw.verdict === "string" &&
      typeof raw.reasoning === "string" &&
      typeof raw.confidence === "number"
    ) {
      const base = {
        verdict: raw.verdict as AcceptanceDiagnoseOutput["verdict"],
        reasoning: raw.reasoning,
        confidence: raw.confidence,
      };

      const findings = acceptanceDiagnoseRawArrayToFindings(raw.findings);
      if (findings.length > 0) return { ...base, findings };

      return base;
    }
    return FALLBACK;
  },
};
