import { acceptanceConfigSelector } from "../config";
import { AcceptancePromptBuilder } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface AcceptanceDiagnoseInput {
  testOutput: string;
  testFileContent: string;
  sourceFiles: Array<{ path: string; content: string }>;
  previousFailure?: string;
}

export interface AcceptanceDiagnoseOutput {
  verdict: "source_bug" | "test_bug" | "both";
  reasoning: string;
  confidence: number;
  testIssues?: string[];
  sourceIssues?: string[];
}

type AcceptanceConfig = ReturnType<typeof acceptanceConfigSelector.select>;

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
  build(input, _ctx) {
    const prompt = new AcceptancePromptBuilder().buildDiagnosisPrompt({
      testOutput: input.testOutput,
      testFileContent: input.testFileContent,
      sourceFiles: input.sourceFiles,
      previousFailure: input.previousFailure,
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
      return {
        verdict: raw.verdict as AcceptanceDiagnoseOutput["verdict"],
        reasoning: raw.reasoning,
        confidence: raw.confidence,
        testIssues: Array.isArray(raw.testIssues) ? (raw.testIssues as string[]) : undefined,
        sourceIssues: Array.isArray(raw.sourceIssues) ? (raw.sourceIssues as string[]) : undefined,
      };
    }
    return FALLBACK;
  },
};
