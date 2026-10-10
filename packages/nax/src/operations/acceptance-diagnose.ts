import { acceptanceConfigSelector } from "../config";
import type { AcceptanceConfig } from "../config/selectors";
import type { FailedCriterion } from "../acceptance/failed-criteria";
import type { Finding } from "../findings";
import { acceptanceDiagnoseRawArrayToFindings } from "../findings";
import { AcceptancePromptBuilder } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface AcceptanceDiagnoseInput {
  testOutput: string;
  testFileContent: string;
  acceptanceTestPath?: string;
  sourceFiles: Array<{ path: string; content: string }>;
  failedCriteria?: FailedCriterion[];
}

export interface AcceptanceDiagnoseOutput {
  verdict: "source_bug" | "test_bug" | "both";
  reasoning: string;
  confidence: number;
  findings?: Finding[];
  fallback?: true;
}

const FALLBACK: AcceptanceDiagnoseOutput = {
  verdict: "test_bug",
  reasoning: "diagnosis failed — falling back to test fix",
  confidence: 0,
  fallback: true,
};

export const acceptanceDiagnoseOp: RunOperation<AcceptanceDiagnoseInput, AcceptanceDiagnoseOutput, AcceptanceConfig> = {
  kind: "run",
  name: "acceptance-diagnose",
  stage: "acceptance",
  session: { role: "diagnose", lifetime: "fresh" },
  config: acceptanceConfigSelector,
  model: (_input, ctx) => ctx.config.acceptance.fix?.diagnoseModel ?? ctx.config.acceptance.model,
  timeoutMs: (_input, ctx) => ctx.config.acceptance.timeoutMs,
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildDiagnosisPrompt({
      testOutput: input.testOutput,
      testFileContent: input.testFileContent,
      acceptanceTestPath: input.acceptanceTestPath,
      sourceFiles: input.sourceFiles,
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
