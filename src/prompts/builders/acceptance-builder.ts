/**
 * AcceptancePromptBuilder
 *
 * Centralises all prompt construction for src/acceptance/:
 *   - generator.ts  → buildGeneratorFromPRDPrompt, buildGeneratorFromSpecPrompt
 *   - fix-diagnosis.ts → buildDiagnosisPromptTemplate
 *   - fix-executor.ts  → buildSourceFixPrompt, buildTestFixPrompt
 *
 * Instance methods (not static) — required by Biome's noStaticOnlyClass rule.
 * Instantiation cost is negligible; builders are short-lived call-and-discard.
 */

import type { PRD } from "../../prd/types";
import { buildTestFrameworkHint } from "../../test-runners";
import { wrapJsonPrompt } from "../../utils/llm-json";
import { formatTestOutputForFix } from "./acceptance-builder-helpers";

export type AcceptanceRole = "generator" | "diagnoser" | "fix-executor";

/**
 * Maximum source file lines included in the diagnosis prompt.
 * Exported so fix-diagnosis.ts can use the same cap when reading files.
 */
export const MAX_FILE_LINES = 500;

// ─── Shared generator step text ───────────────────────────────────────────────

const STEP1 = `## Step 1: Understand and Classify the Acceptance Criteria

Read each AC below and classify its verification type (prefer runtime-check):
- **runtime-check** (PREFERRED): Import the module, call the function, assert on return values, thrown errors, or observable side effects. This is the strongest verification — use it whenever possible.
- **integration-check**: Requires a running service (e.g. HTTP endpoint returns 200, database query succeeds). Use setup blocks.
- **file-check** (LAST RESORT): Only for ACs that genuinely cannot be verified at runtime (e.g. "no banned imports in file X", "config file exists"). Never use file-check when a runtime import + assertion would work.`;

const STEP2 = `## Step 2: Explore the Project

Before writing any tests, examine the project to understand:
1. **Language and test framework** — check dependency manifests (package.json, go.mod, Gemfile, pyproject.toml, Cargo.toml, build.gradle, etc.) to identify the language and test runner
2. **Existing test patterns** — read 1-2 existing test files to understand import style, describe/test/it conventions, and available helpers
3. **Project structure** — identify relevant source directories to determine correct import or load paths`;

const STEP3_HEADER = `## Step 3: Generate the Acceptance Test File

Write the complete acceptance test file using the framework identified in Step 2.

Rules:`;

const STEP3_SHARED_RULES = `- **One test per AC**, named exactly "AC-N: <description>"
- **runtime-check ACs** (default) → import the module directly, call functions with test inputs, assert on return values or observable side effects (log calls, thrown errors, state changes)
- **integration-check ACs** → use the language's HTTP client or existing test helpers; add a clear setup block (beforeAll/setup/TestMain/etc.) explaining what must be running
- **file-check ACs** (last resort only) → read source files using the language's standard file I/O, assert with string or regex checks. Only use when the AC explicitly asks about file contents or imports — never use file-check to verify behavior that can be tested by calling the function
- **NEVER use placeholder assertions** — no always-passing or always-failing stubs, no TODO comments as the only content, no empty test bodies
- Every test MUST have real assertions that PASS when the feature is correctly implemented and FAIL when it is broken
- **Prefer behavioral tests** — import functions and call them rather than reading source files. For example, to verify "getPostRunActions() returns empty array", import PluginRegistry and call getPostRunActions(), don't grep the source file for the method name.`;

// ─── Additional parameter interfaces (moved from acceptance domain) ───────────

export interface FixGeneratorParams {
  batchedACs: string[];
  acTextMap: Record<string, string>;
  testOutput: string;
  relatedStories: string[];
  prd: PRD;
  testFilePath?: string;
}

export interface DiagnosisPromptParams {
  testOutput: string;
  testFileContent: string;
  acceptanceTestPath?: string;
  sourceFiles: Array<{ path: string; content: string }>;
  /** Minimal shape — avoids importing SemanticVerdict across layers */
  semanticVerdicts?: Array<{ storyId: string; passed: boolean }>;
}

export interface RefinementPromptOptions {
  testStrategy?: "unit" | "component" | "cli" | "e2e" | "snapshot";
  testFramework?: string;
  storyTitle?: string;
  storyDescription?: string;
}

// ─── Parameter interfaces ─────────────────────────────────────────────────────

export interface GeneratorFromPRDParams {
  featureName: string;
  criteriaList: string;
  frameworkOverrideLine: string;
  /** Fully resolved absolute path for the test file output. */
  targetTestFilePath: string;
  implementationContext?: Array<{ path: string; content: string }>;
}

export interface GeneratorFromSpecParams {
  featureName: string;
  criteriaList: string;
  resolvedTestPath: string;
}

export interface DiagnosisTemplateParams {
  truncatedOutput: string;
  acceptanceTestPath: string;
  sourceFilesSection: string;
  verdictSection: string;
  maxFileLines: number;
}

export interface SourceFixParams {
  testOutput: string;
  testCommand?: string;
  diagnosisReasoning?: string;
  priorIterationsBlock?: string;
  acceptanceTestPath: string;
}

export interface TestFixParams {
  testOutput: string;
  testCommand?: string;
  diagnosisReasoning?: string;
  priorIterationsBlock?: string;
  failedACs: string[];
  acceptanceTestPath: string;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export class AcceptancePromptBuilder {
  /** Prompt for acceptanceGenerateOp — agent writes file directly to targetTestFilePath. */
  buildGeneratorFromPRDPrompt(p: GeneratorFromPRDParams): string {
    const frameworkLine = p.frameworkOverrideLine ? `\n${p.frameworkOverrideLine}` : "";
    const implSection =
      p.implementationContext && p.implementationContext.length > 0
        ? `\n\n## Implementation (already exists)\n\n${p.implementationContext.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}`
        : "";
    return `You are a senior test engineer. Your task is to generate a complete acceptance test file for the "${p.featureName}" feature.

${STEP1}

ACCEPTANCE CRITERIA:
${p.criteriaList}

${STEP2}${frameworkLine}

${STEP3_HEADER}
${STEP3_SHARED_RULES}
- **File output (REQUIRED)**: Write the acceptance test file DIRECTLY to the path shown below. Do NOT output the test code in your response. After writing the file, reply with a brief confirmation.
- **Path anchor (CRITICAL)**: Write the test file to this exact path: \`${p.targetTestFilePath}\`. Import from package sources using relative paths like \`../../../src/...\` (3 levels up from \`.nax/features/<name>/\` to the package root).
- **Process cwd**: When spawning child processes to invoke a CLI or binary, set the working directory to the **package root** (\`join(import.meta.dir, "../../..")\`) as your default — unless your Step 2 exploration reveals the CLI uses a different working directory convention (e.g. reads config from \`~/.config/\`, or resolves paths relative to a flag value). Always check how the CLI resolves file paths before assuming.${implSection}`;
  }

  /** Prompt for generateAcceptanceTests() — agent returns raw test code. */
  buildGeneratorFromSpecPrompt(p: GeneratorFromSpecParams): string {
    return `You are a senior test engineer. Your task is to generate a complete acceptance test file for the "${p.featureName}" feature.

${STEP1}

ACCEPTANCE CRITERIA:
${p.criteriaList}

${STEP2}

${STEP3_HEADER}
${STEP3_SHARED_RULES}
- Output raw code only — no markdown fences, start directly with the language's import or package declaration
- **Path anchor (CRITICAL)**: This test file will be saved at \`<repo-root>/.nax/features/${p.featureName}/${p.resolvedTestPath}\` and will ALWAYS run from the repo root. The repo root is exactly 3 \`../\` levels above \`__dirname\`: \`join(__dirname, '..', '..', '..')\`. For monorepo projects, navigate into packages from root (e.g. \`join(root, 'apps/api/src')\`).`;
  }

  /** Template assembly for buildDiagnosisPrompt() — receives pre-processed strings. */
  buildDiagnosisPromptTemplate(p: DiagnosisTemplateParams): string {
    const responseSchema = `{
  "verdict": "source_bug" | "test_bug" | "both",
  "reasoning": "Your analysis explaining why this is a source_bug, test_bug, or both",
  "confidence": 0.0-1.0,
  "findings": [
    {
      "fixTarget": "source" | "test",
      "category": "stdout-capture" | "ac-mismatch" | "framework-misuse" | "missing-impl" | "import-path" | "hook-failure" | "test-runner-error" | "stub-test" | "other",
      "file": "optional/path/relative/to/workdir.ts",
      "line": 0,
      "message": "Concrete description of the issue",
      "suggestion": "Optional concrete fix suggestion"
    }
  ]
}`;

    return `You are a debugging expert. An acceptance test has failed.

TASK: Diagnose whether the failure is due to a bug in the SOURCE CODE or a bug in the TEST CODE.

FAILING TEST OUTPUT:
${p.truncatedOutput}

ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}

(Use Read on the path above to inspect the test code if needed for diagnosis.)

SOURCE FILES (auto-detected from imports, up to ${p.maxFileLines} lines each):
${p.sourceFilesSection}
${p.verdictSection}
Respond with ONLY a JSON object in this exact format (no markdown, no extra text):
${responseSchema}`;
  }

  /** Prompt for acceptanceFixSourceOp — instructs agent to fix source implementation. */
  buildSourceFixPrompt(p: SourceFixParams): string {
    let prompt = "ACCEPTANCE TEST FAILURE — fix the source implementation.\n\n";
    if (p.testCommand) prompt += `Test framework: ${buildTestFrameworkHint(p.testCommand)}\n\n`;
    prompt += `TEST OUTPUT:\n${formatTestOutputForFix(p.testOutput)}\n\n`;
    if (p.diagnosisReasoning) prompt += `DIAGNOSIS:\n${p.diagnosisReasoning}\n\n`;
    if (p.priorIterationsBlock) prompt += p.priorIterationsBlock;
    prompt += `ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}\n\n`;
    prompt += "Read the test file at the path above for context, then fix the source implementation. ";
    prompt += "Do NOT modify the test file.";
    return prompt;
  }

  /**
   * Prompt for generateFixStories() — asks the LLM to produce a fix description
   * for a batch of failed acceptance criteria.
   */
  buildFixGeneratorPrompt(p: FixGeneratorParams): string {
    const acList = p.batchedACs.map((ac) => `${ac}: ${p.acTextMap[ac] || "No description available"}`).join("\n");

    const relatedStoriesText = p.relatedStories
      .map((id) => {
        const story = p.prd.userStories.find((s) => s.id === id);
        if (!story) return "";
        return `${story.id}: ${story.title}\n  ${story.description}`;
      })
      .filter(Boolean)
      .join("\n\n");

    const testFileSection = p.testFilePath
      ? `\nACCEPTANCE TEST FILE: ${p.testFilePath}\n(Read this file first to understand what each test expects)\n`
      : "";

    return `You are a debugging expert. Feature acceptance tests have failed.${testFileSection}
FAILED ACCEPTANCE CRITERIA (${p.batchedACs.length} total):
${acList}

TEST FAILURE OUTPUT:
${p.testOutput.slice(0, 2000)}

RELATED STORIES (implemented this functionality):
${relatedStoriesText}

Your task: Generate a fix description that will make these acceptance tests pass.

Requirements:
1. Read the acceptance test file first to understand what each failing test expects
2. Identify the root cause based on the test failure output
3. Find and fix the relevant implementation code (do NOT modify the test file)
4. Write a clear, actionable fix description (2-4 sentences)
5. Reference the relevant story IDs if needed

Respond with ONLY the fix description (no JSON, no markdown, just the description text).`;
  }

  /**
   * Prompt for acceptanceDiagnoseOp — pre-processes raw data and assembles
   * the full diagnosis prompt via buildDiagnosisPromptTemplate().
   */
  buildDiagnosisPrompt(p: DiagnosisPromptParams): string {
    const MAX_TEST_OUTPUT_CHARS = 2000;
    const truncatedOutput = p.testOutput.slice(0, MAX_TEST_OUTPUT_CHARS);

    const sourceFilesSection =
      p.sourceFiles.length > 0
        ? p.sourceFiles.map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
        : "(No source files could be resolved from imports)";

    const verdictSection =
      p.semanticVerdicts && p.semanticVerdicts.length > 0
        ? `\nSEMANTIC VERDICTS:\n${p.semanticVerdicts.map((v) => `- ${v.storyId}: ${v.passed ? "likely test bug (semantic review confirmed AC implementation)" : "unconfirmed"}`).join("\n")}\n`
        : "";

    return this.buildDiagnosisPromptTemplate({
      truncatedOutput,
      acceptanceTestPath: p.acceptanceTestPath ?? "(path unavailable — inspect test output for file references)",
      sourceFilesSection,
      verdictSection,
      maxFileLines: MAX_FILE_LINES,
    });
  }

  /**
   * Prompt for acceptanceRefineOp — converts raw ACs into concrete
   * machine-verifiable assertions, with optional strategy-specific instructions.
   */
  buildRefinementPrompt(criteria: string[], codebaseContext: string, options?: RefinementPromptOptions): string {
    const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const strategySection = this.buildStrategySection(options);
    const refinedExample = this.buildRefinedExample(options?.testStrategy);

    const storyLines: string[] = [];
    if (options?.storyTitle) storyLines.push(`Title: ${options.storyTitle}`);
    if (options?.storyDescription) storyLines.push(`Description: ${options.storyDescription}`);
    const storySection = storyLines.length > 0 ? `STORY CONTEXT:\n${storyLines.join("\n")}\n\n` : "";

    const codebaseSection = codebaseContext ? `CODEBASE CONTEXT:\n${codebaseContext}\n` : "";

    const core = `You are an acceptance criteria refinement assistant. Your task is to convert raw acceptance criteria into concrete, machine-verifiable assertions.

${storySection}${codebaseSection}${strategySection}ACCEPTANCE CRITERIA TO REFINE:
${criteriaList}

For each criterion, produce a refined version that is concrete and automatically testable where possible.
Respond with a JSON array:
[{
  "original": "<exact original criterion text>",
  "refined": "<concrete, machine-verifiable description>",
  "testable": true,
  "storyId": ""
}]

Rules:
- "original" must match the input criterion text exactly
- "refined" must be a concrete assertion (e.g., ${refinedExample})
- "testable" is false only if the criterion cannot be automatically verified (e.g., "UX feels responsive", "design looks good")
- "storyId" leave as empty string — it will be assigned by the caller`;

    return wrapJsonPrompt(core);
  }

  private buildStrategySection(options?: RefinementPromptOptions): string {
    if (!options?.testStrategy) return "";

    const framework = options.testFramework ? ` Use ${options.testFramework} testing library syntax.` : "";

    switch (options.testStrategy) {
      case "component":
        return `
TEST STRATEGY: component
Focus assertions on rendered output visible on screen — text content, visible elements, and screen state.
Assert what the user sees rendered in the component, not what internal functions produce.${framework}
`;
      case "cli":
        return `
TEST STRATEGY: cli
Focus assertions on stdout and stderr text output from the CLI command.
Assert about terminal output content, exit codes, and standard output/standard error streams.${framework}
`;
      case "e2e":
        return `
TEST STRATEGY: e2e
Focus assertions on HTTP response content — status codes, response bodies, and endpoint behavior.
Assert about HTTP responses, status codes, and API endpoint output.${framework}
`;
      default:
        return framework ? `\nTEST FRAMEWORK: ${options.testFramework}\n` : "";
    }
  }

  private buildRefinedExample(testStrategy?: RefinementPromptOptions["testStrategy"]): string {
    switch (testStrategy) {
      case "component":
        return '"Text content visible on screen matches expected", "Rendered output contains expected element"';
      case "cli":
        return '"stdout contains expected text", "stderr is empty on success", "exit code is 0"';
      case "e2e":
        return '"HTTP status 200 returned", "Response body contains expected field", "Endpoint returns JSON"';
      default:
        return '"Array of length N returned", "HTTP status 200 returned"';
    }
  }

  /** Prompt for acceptanceFixTestOp — instructs agent to fix failing test assertions. */
  buildTestFixPrompt(p: TestFixParams): string {
    let prompt = "ACCEPTANCE TEST BUG — surgical fix required.\n\n";
    prompt += `FAILING ACS: ${p.failedACs.join(", ")}\n\n`;
    if (p.testCommand) prompt += `Test framework: ${buildTestFrameworkHint(p.testCommand)}\n\n`;
    prompt += `TEST OUTPUT:\n${formatTestOutputForFix(p.testOutput)}\n\n`;
    if (p.diagnosisReasoning) prompt += `DIAGNOSIS:\n${p.diagnosisReasoning}\n\n`;
    if (p.priorIterationsBlock) prompt += p.priorIterationsBlock;
    prompt += `ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}\n\n`;
    prompt += "Read the test file at the path above before editing. The fix should be ";
    prompt += "surgical — locate the failing AC blocks and adjust their assertions only. ";
    prompt += "Do NOT modify passing tests. Do NOT modify source code. ";
    prompt += "Edit the test file in place.";
    return prompt;
  }
}
