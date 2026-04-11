/**
 * Acceptance Fix Diagnosis
 *
 * Runs a full agent session to diagnose acceptance test failures.
 * Determines whether the failure is due to a source bug, test bug, or both.
 */

import { buildSessionName } from "../agents/acp/adapter";
import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config/schema";
import { type ModelTier, resolveModelForAgent } from "../config/schema-types";
import { AcceptancePromptBuilder } from "../prompts/builders/acceptance-builder";
import { tryParseLLMJson } from "../utils/llm-json";
import type { DiagnosisResult, SemanticVerdict } from "./types";

export interface DiagnoseOptions {
  testOutput: string;
  testFileContent: string;
  config: NaxConfig;
  workdir: string;
  featureName?: string;
  storyId?: string;
  semanticVerdicts?: SemanticVerdict[];
  /** Accumulated context from prior failed fix attempts — included in the diagnosis prompt */
  previousFailure?: string;
}

const MAX_SOURCE_FILES = 5;
const MAX_FILE_LINES = 500;
const MAX_TEST_OUTPUT_CHARS = 2000;

function parseImportStatements(content: string): string[] {
  const importRegex = /import\s+(?:{[^}]+}|[^;]+)\s+from\s+["']([^"']+)["']/g;
  const imports: string[] = [];
  const regexMatch = content.matchAll(importRegex);
  for (const match of regexMatch) {
    imports.push(match[1]);
  }
  return imports;
}

function resolveImportPaths(imports: string[], _workdir: string): string[] {
  const resolved: string[] = [];
  for (const imp of imports) {
    if (imp.startsWith(".")) {
      resolved.push(imp);
    }
  }
  return resolved.slice(0, MAX_SOURCE_FILES);
}

async function readSourceFileContent(
  filePath: string,
  workdir: string,
): Promise<{ path: string; content: string } | null> {
  try {
    const fullPath = `${workdir}/${filePath}`;
    const file = await Bun.file(fullPath).text();
    const lines = file.split("\n").slice(0, MAX_FILE_LINES);
    return { path: filePath, content: lines.join("\n") };
  } catch {
    return null;
  }
}

export function buildDiagnosisPrompt(options: {
  testOutput: string;
  testFileContent: string;
  sourceFiles: Array<{ path: string; content: string }>;
  semanticVerdicts?: SemanticVerdict[];
  previousFailure?: string;
}): string {
  const truncatedOutput = options.testOutput.slice(0, MAX_TEST_OUTPUT_CHARS);

  const sourceFilesSection =
    options.sourceFiles.length > 0
      ? options.sourceFiles.map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
      : "(No source files could be resolved from imports)";

  let verdictSection = "";
  if (options.semanticVerdicts && options.semanticVerdicts.length > 0) {
    const lines = options.semanticVerdicts.map((v) => {
      const status = v.passed ? "likely test bug (semantic review confirmed AC implementation)" : "unconfirmed";
      return `- ${v.storyId}: ${status}`;
    });
    verdictSection = `\nSEMANTIC VERDICTS:\n${lines.join("\n")}\n`;
  }

  let previousFailureSection = "";
  if (options.previousFailure && options.previousFailure.length > 0) {
    previousFailureSection = `\nPREVIOUS FIX ATTEMPTS:\n${options.previousFailure}\n`;
  }

  return new AcceptancePromptBuilder().buildDiagnosisPromptTemplate({
    truncatedOutput,
    testFileContent: options.testFileContent,
    sourceFilesSection,
    verdictSection,
    previousFailureSection,
    maxFileLines: MAX_FILE_LINES,
  });
}

export async function diagnoseAcceptanceFailure(
  agent: AgentAdapter,
  options: DiagnoseOptions,
): Promise<DiagnosisResult> {
  if (!agent) {
    throw new Error("[diagnosis] Agent adapter is required");
  }

  const { testOutput, testFileContent, config, workdir, featureName, storyId } = options;

  const sessionName = buildSessionName(workdir, featureName, storyId, "diagnose");

  const diagnoseModelTier = config.acceptance.fix.diagnoseModel;
  const modelDef = resolveModelForAgent(
    config.models,
    config.autoMode.defaultAgent,
    diagnoseModelTier as ModelTier,
    config.autoMode.defaultAgent,
  );

  const imports = parseImportStatements(testFileContent);
  const relativeImports = resolveImportPaths(imports, workdir);
  const sourceFiles = await Promise.all(relativeImports.map((imp) => readSourceFileContent(imp, workdir)));
  const validSourceFiles = sourceFiles.filter((f): f is { path: string; content: string } => f !== null);

  const prompt = buildDiagnosisPrompt({
    testOutput,
    testFileContent,
    sourceFiles: validSourceFiles,
    semanticVerdicts: options.semanticVerdicts,
    previousFailure: options.previousFailure,
  });

  try {
    const timeoutSeconds = (config.acceptance?.timeoutMs ?? 120_000) / 1000;

    const result = await agent.run({
      prompt,
      workdir,
      modelTier: undefined as unknown as "fast" | "balanced" | "powerful",
      modelDef,
      timeoutSeconds,
      sessionRole: "diagnose",
      acpSessionName: sessionName,
      featureName,
      storyId,
      config,
    } as Parameters<AgentAdapter["run"]>[0]);

    const diagnosis = parseDiagnosisResult(result.output);
    if (diagnosis) {
      return { ...diagnosis, cost: result.estimatedCost ?? 0 };
    }

    return {
      verdict: "source_bug",
      reasoning: "diagnosis failed — falling back to source fix",
      confidence: 0,
      cost: result.estimatedCost ?? 0,
    };
  } catch {
    return {
      verdict: "source_bug",
      reasoning: "diagnosis failed — falling back to source fix",
      confidence: 0,
    };
  }
}

function parseDiagnosisResult(output: string): DiagnosisResult | null {
  if (!output || output.trim() === "") {
    return null;
  }

  const parsed = tryParseLLMJson<Record<string, unknown>>(output);
  if (
    parsed &&
    typeof parsed.verdict === "string" &&
    typeof parsed.reasoning === "string" &&
    typeof parsed.confidence === "number"
  ) {
    return {
      verdict: parsed.verdict as DiagnosisResult["verdict"],
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
      testIssues: Array.isArray(parsed.testIssues) ? (parsed.testIssues as string[]) : undefined,
      sourceIssues: Array.isArray(parsed.sourceIssues) ? (parsed.sourceIssues as string[]) : undefined,
    };
  }
  return null;
}
