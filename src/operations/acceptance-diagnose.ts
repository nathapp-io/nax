import type { SemanticVerdict } from "../acceptance/types";
import { acceptanceConfigSelector } from "../config";
import type { AcceptanceConfig } from "../config/selectors";
import type { Finding } from "../findings";
import { AcceptancePromptBuilder } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface AcceptanceDiagnoseInput {
  testOutput: string;
  testFileContent: string;
  sourceFiles: Array<{ path: string; content: string }>;
  semanticVerdicts?: SemanticVerdict[];
  previousFailure?: string;
}

export interface AcceptanceDiagnoseOutput {
  verdict: "source_bug" | "test_bug" | "both";
  reasoning: string;
  confidence: number;
  /** findingsV2 mode: structured findings supersede testIssues/sourceIssues */
  findings?: Finding[];
  testIssues?: string[];
  sourceIssues?: string[];
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
  build(input, ctx) {
    const findingsV2 = ctx.config.acceptance.fix?.findingsV2 ?? false;
    const prompt = new AcceptancePromptBuilder().buildDiagnosisPrompt({
      testOutput: input.testOutput,
      testFileContent: input.testFileContent,
      sourceFiles: input.sourceFiles,
      semanticVerdicts: input.semanticVerdicts,
      previousFailure: input.previousFailure,
      findingsV2,
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

      // findingsV2 path: LLM emits findings[] directly
      if (Array.isArray(raw.findings) && raw.findings.length > 0) {
        return { ...base, findings: raw.findings as Finding[] };
      }

      // Legacy path: wrap testIssues/sourceIssues as Finding[] for uniform consumption
      const legacyFindings: Finding[] = [];
      if (Array.isArray(raw.testIssues)) {
        for (const msg of raw.testIssues as string[]) {
          legacyFindings.push({
            source: "acceptance-diagnose",
            severity: "error",
            category: "legacy",
            message: msg,
            fixTarget: "test",
          });
        }
      }
      if (Array.isArray(raw.sourceIssues)) {
        for (const msg of raw.sourceIssues as string[]) {
          legacyFindings.push({
            source: "acceptance-diagnose",
            severity: "error",
            category: "legacy",
            message: msg,
            fixTarget: "source",
          });
        }
      }

      return {
        ...base,
        findings: legacyFindings.length > 0 ? legacyFindings : undefined,
        testIssues: Array.isArray(raw.testIssues) ? (raw.testIssues as string[]) : undefined,
        sourceIssues: Array.isArray(raw.sourceIssues) ? (raw.sourceIssues as string[]) : undefined,
      };
    }
    return FALLBACK;
  },
};
