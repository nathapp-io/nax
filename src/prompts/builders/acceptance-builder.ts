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

export type AcceptanceRole = "generator" | "diagnoser" | "fix-executor";

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

// ─── Parameter interfaces ─────────────────────────────────────────────────────

export interface GeneratorFromPRDParams {
  featureName: string;
  criteriaList: string;
  frameworkOverrideLine: string;
  /** Fully resolved absolute path for the test file output. */
  targetTestFilePath: string;
  implementationContext?: Array<{ path: string; content: string }>;
  previousFailure?: string;
}

export interface GeneratorFromSpecParams {
  featureName: string;
  criteriaList: string;
  resolvedTestPath: string;
}

export interface DiagnosisTemplateParams {
  truncatedOutput: string;
  testFileContent: string;
  sourceFilesSection: string;
  verdictSection: string;
  previousFailureSection: string;
  maxFileLines: number;
}

export interface SourceFixParams {
  testOutput: string;
  diagnosisReasoning?: string;
  acceptanceTestPath: string;
  testFileContent?: string;
}

export interface TestFixParams {
  testOutput: string;
  diagnosisReasoning?: string;
  failedACs: string[];
  previousFailure?: string;
  acceptanceTestPath: string;
  testFileContent: string;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export class AcceptancePromptBuilder {
  /** Prompt for generateFromPRD() — agent writes file directly to targetTestFilePath. */
  buildGeneratorFromPRDPrompt(p: GeneratorFromPRDParams): string {
    const frameworkLine = p.frameworkOverrideLine ? `\n${p.frameworkOverrideLine}` : "";
    const implSection =
      p.implementationContext && p.implementationContext.length > 0
        ? `\n\n## Implementation (already exists)\n\n${p.implementationContext.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}`
        : "";
    const prevFailureSection =
      p.previousFailure && p.previousFailure.length > 0 ? `\n\nPrevious test failed because: ${p.previousFailure}` : "";

    return `You are a senior test engineer. Your task is to generate a complete acceptance test file for the "${p.featureName}" feature.

${STEP1}

ACCEPTANCE CRITERIA:
${p.criteriaList}

${STEP2}${frameworkLine}

${STEP3_HEADER}
${STEP3_SHARED_RULES}
- **File output (REQUIRED)**: Write the acceptance test file DIRECTLY to the path shown below. Do NOT output the test code in your response. After writing the file, reply with a brief confirmation.
- **Path anchor (CRITICAL)**: Write the test file to this exact path: \`${p.targetTestFilePath}\`. Import from package sources using relative paths like \`../../../src/...\` (3 levels up from \`.nax/features/<name>/\` to the package root).
- **Process cwd**: When spawning child processes to invoke a CLI or binary, set the working directory to the **package root** (\`join(import.meta.dir, "../../..")\`) as your default — unless your Step 2 exploration reveals the CLI uses a different working directory convention (e.g. reads config from \`~/.config/\`, or resolves paths relative to a flag value). Always check how the CLI resolves file paths before assuming.${implSection}${prevFailureSection}`;
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
    return `You are a debugging expert. An acceptance test has failed.

TASK: Diagnose whether the failure is due to a bug in the SOURCE CODE or a bug in the TEST CODE.

FAILING TEST OUTPUT:
${p.truncatedOutput}

ACCEPTANCE TEST FILE CONTENT:
\`\`\`typescript
${p.testFileContent}
\`\`\`

SOURCE FILES (auto-detected from imports, up to ${p.maxFileLines} lines each):
${p.sourceFilesSection}
${p.verdictSection}${p.previousFailureSection}
Respond with ONLY a JSON object in this exact format (no markdown, no extra text):
{
  "verdict": "source_bug" | "test_bug" | "both",
  "reasoning": "Your analysis explaining why this is a source_bug, test_bug, or both",
  "confidence": 0.0-1.0,
  "testIssues": ["Issue in test code if any"],
  "sourceIssues": ["Issue in source code if any"]
}`;
  }

  /** Prompt for executeSourceFix() — instructs agent to fix source implementation. */
  buildSourceFixPrompt(p: SourceFixParams): string {
    let prompt = `ACCEPTANCE TEST FAILURE:\n${p.testOutput}\n\n`;
    if (p.diagnosisReasoning) prompt += `DIAGNOSIS:\n${p.diagnosisReasoning}\n\n`;
    prompt += `ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}\n\n`;
    if (p.testFileContent && p.testFileContent.length > 0) {
      prompt += `\`\`\`typescript\n${p.testFileContent}\n\`\`\`\n\n`;
    }
    prompt += "Fix the source implementation. Do NOT modify the test file.";
    return prompt;
  }

  /** Prompt for executeTestFix() — instructs agent to fix failing test assertions. */
  buildTestFixPrompt(p: TestFixParams): string {
    let prompt = "ACCEPTANCE TEST BUG — surgical fix required.\n\n";
    prompt += `FAILING ACS: ${p.failedACs.join(", ")}\n\n`;
    prompt += `TEST OUTPUT:\n${p.testOutput}\n\n`;
    if (p.diagnosisReasoning) prompt += `DIAGNOSIS:\n${p.diagnosisReasoning}\n\n`;
    if (p.previousFailure && p.previousFailure.length > 0) {
      prompt += `PREVIOUS FAILED ATTEMPTS:\n${p.previousFailure}\n\n`;
    }
    prompt += `ACCEPTANCE TEST FILE: ${p.acceptanceTestPath}\n\n`;
    prompt += `\`\`\`typescript\n${p.testFileContent}\n\`\`\`\n\n`;
    prompt += "Fix ONLY the failing test assertions for the ACs listed above. ";
    prompt += "Do NOT modify passing tests. Do NOT modify source code. ";
    prompt += "Edit the test file in place.";
    return prompt;
  }
}
