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
import type { DiagnosisResult, SemanticVerdict } from "./types";

export interface DiagnoseOptions {
  testOutput: string;
  testFileContent: string;
  config: NaxConfig;
  workdir: string;
  featureName?: string;
  storyId?: string;
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

function resolveImportPaths(imports: string[], workdir: string): string[] {
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

  return `You are a debugging expert. An acceptance test has failed.

TASK: Diagnose whether the failure is due to a bug in the SOURCE CODE or a bug in the TEST CODE.

FAILING TEST OUTPUT:
${truncatedOutput}

ACCEPTANCE TEST FILE CONTENT:
\`\`\`typescript
${options.testFileContent}
\`\`\`

SOURCE FILES (auto-detected from imports, up to ${MAX_FILE_LINES} lines each):
${sourceFilesSection}
${verdictSection}
Respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{
  "verdict": "source_bug" | "test_bug" | "both",
  "reasoning": "Your analysis explaining why this is a source_bug, test_bug, or both",
  "confidence": 0.0-1.0,
  "testIssues": ["Issue in test code if any"],
  "sourceIssues": ["Issue in source code if any"]
}`;
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
  });

  try {
    const result = await agent.run({
      prompt,
      workdir,
      modelTier: undefined as unknown as "fast" | "balanced" | "powerful",
      modelDef,
      timeoutSeconds: 300,
      sessionRole: "diagnose",
      acpSessionName: sessionName,
      featureName,
      storyId,
      config,
    } as Parameters<AgentAdapter["run"]>[0]);

    const diagnosis = parseDiagnosisResult(result.output);
    if (diagnosis) {
      return diagnosis;
    }

    return {
      verdict: "source_bug",
      reasoning: "diagnosis failed — falling back to source fix",
      confidence: 0,
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

  try {
    const cleaned = output.trim();
    let jsonStr = cleaned;

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);
    if (
      typeof parsed.verdict === "string" &&
      typeof parsed.reasoning === "string" &&
      typeof parsed.confidence === "number"
    ) {
      return {
        verdict: parsed.verdict,
        reasoning: parsed.reasoning,
        confidence: parsed.confidence,
        testIssues: parsed.testIssues,
        sourceIssues: parsed.sourceIssues,
      };
    }
    return null;
  } catch {
    return null;
  }
}
