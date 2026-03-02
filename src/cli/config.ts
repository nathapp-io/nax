/**
 * Config Command
 *
 * Displays effective merged configuration with inline explanations.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../config/schema";
import { globalConfigPath, findProjectDir } from "../config/loader";

/** Field descriptions for human-readable output */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  // Top-level
  "version": "Configuration schema version",

  // Models
  "models": "Model tier definitions (fast/balanced/powerful)",
  "models.fast": "Fast model for lightweight tasks (e.g., haiku)",
  "models.balanced": "Balanced model for general coding (e.g., sonnet)",
  "models.powerful": "Powerful model for complex tasks (e.g., opus)",

  // Auto mode
  "autoMode": "Auto mode configuration for agent orchestration",
  "autoMode.enabled": "Enable automatic agent selection and escalation",
  "autoMode.defaultAgent": "Default agent to use (e.g., claude, codex)",
  "autoMode.fallbackOrder": "Fallback order when agent is rate-limited",
  "autoMode.complexityRouting": "Model tier per complexity level",
  "autoMode.complexityRouting.simple": "Model tier for simple tasks",
  "autoMode.complexityRouting.medium": "Model tier for medium tasks",
  "autoMode.complexityRouting.complex": "Model tier for complex tasks",
  "autoMode.complexityRouting.expert": "Model tier for expert tasks",
  "autoMode.escalation": "Escalation settings for failed stories",
  "autoMode.escalation.enabled": "Enable tier escalation on failure",
  "autoMode.escalation.tierOrder": "Ordered tier escalation with per-tier attempt budgets",
  "autoMode.escalation.escalateEntireBatch": "Escalate all stories in batch when one fails",

  // Routing
  "routing": "Model routing strategy configuration",
  "routing.strategy": "Routing strategy: keyword | llm | manual | adaptive | custom",
  "routing.customStrategyPath": "Path to custom routing strategy (if strategy=custom)",
  "routing.adaptive": "Adaptive routing settings",
  "routing.adaptive.minSamples": "Minimum samples before adaptive routing activates",
  "routing.adaptive.costThreshold": "Cost threshold for strategy switching (0-1)",
  "routing.adaptive.fallbackStrategy": "Fallback strategy if adaptive fails",
  "routing.llm": "LLM-based routing settings",
  "routing.llm.model": "Model tier for routing decisions",
  "routing.llm.fallbackToKeywords": "Fall back to keyword routing on LLM failure",
  "routing.llm.cacheDecisions": "Cache routing decisions per story ID",
  "routing.llm.mode": "Routing mode: one-shot | per-story | hybrid",
  "routing.llm.timeoutMs": "Timeout for LLM routing call in milliseconds",

  // Execution
  "execution": "Execution limits and timeouts",
  "execution.maxIterations": "Max iterations per feature run (auto-calculated if not set)",
  "execution.iterationDelayMs": "Delay between iterations in milliseconds",
  "execution.costLimit": "Max cost in USD before pausing execution",
  "execution.sessionTimeoutSeconds": "Timeout per agent coding session in seconds",
  "execution.verificationTimeoutSeconds": "Verification subprocess timeout in seconds",
  "execution.maxStoriesPerFeature": "Max stories per feature (prevents memory exhaustion)",
  "execution.contextProviderTokenBudget": "Token budget for plugin context providers",
  "execution.lintCommand": "Lint command override (null=disabled, undefined=auto-detect)",
  "execution.typecheckCommand": "Typecheck command override (null=disabled, undefined=auto-detect)",
  "execution.dangerouslySkipPermissions": "Skip permissions for agent (use with caution)",
  "execution.rectification": "Rectification loop settings (retry failed tests)",
  "execution.rectification.enabled": "Enable rectification loop",
  "execution.rectification.maxRetries": "Max retry attempts per story",
  "execution.rectification.fullSuiteTimeoutSeconds": "Timeout for full test suite run in seconds",
  "execution.rectification.maxFailureSummaryChars": "Max characters in failure summary",
  "execution.rectification.abortOnIncreasingFailures": "Abort if failure count increases",
  "execution.regressionGate": "Regression gate settings (full suite after scoped tests)",
  "execution.regressionGate.enabled": "Enable full-suite regression gate",
  "execution.regressionGate.timeoutSeconds": "Timeout for regression run in seconds",

  // Quality
  "quality": "Quality gate configuration",
  "quality.requireTypecheck": "Require typecheck to pass",
  "quality.requireLint": "Require lint to pass",
  "quality.requireTests": "Require tests to pass",
  "quality.commands": "Custom quality commands",
  "quality.commands.typecheck": "Custom typecheck command",
  "quality.commands.lint": "Custom lint command",
  "quality.commands.test": "Custom test command",
  "quality.forceExit": "Append --forceExit to test command (prevents hangs)",
  "quality.detectOpenHandles": "Append --detectOpenHandles on timeout",
  "quality.detectOpenHandlesRetries": "Max retries with --detectOpenHandles",
  "quality.gracePeriodMs": "Grace period in ms after SIGTERM before SIGKILL",
  "quality.drainTimeoutMs": "Deadline in ms to drain stdout/stderr after kill",
  "quality.shell": "Shell to use for verification commands",
  "quality.stripEnvVars": "Environment variables to strip during verification",
  "quality.environmentalEscalationDivisor": "Divisor for environmental failure early escalation",

  // TDD
  "tdd": "Test-driven development configuration",
  "tdd.maxRetries": "Max retries per TDD session before escalating",
  "tdd.autoVerifyIsolation": "Auto-verify test isolation between sessions",
  "tdd.strategy": "TDD strategy: auto | strict | lite | off",
  "tdd.autoApproveVerifier": "Auto-approve legitimate fixes in verifier session",
  "tdd.sessionTiers": "Per-session model tier overrides",
  "tdd.sessionTiers.testWriter": "Model tier for test-writer session",
  "tdd.sessionTiers.implementer": "Model tier for implementer session",
  "tdd.sessionTiers.verifier": "Model tier for verifier session",
  "tdd.testWriterAllowedPaths": "Glob patterns for files test-writer can modify",
  "tdd.rollbackOnFailure": "Rollback git changes when TDD fails",
  "tdd.greenfieldDetection": "Force test-after on projects with no test files",

  // Constitution
  "constitution": "Constitution settings (core rules and constraints)",
  "constitution.enabled": "Enable constitution loading and injection",
  "constitution.path": "Path to constitution file (relative to nax/ directory)",
  "constitution.maxTokens": "Maximum tokens allowed for constitution content",
  "constitution.skipGlobal": "Skip loading global constitution",

  // Analyze
  "analyze": "Feature analysis settings",
  "analyze.llmEnhanced": "Enable LLM-enhanced analysis",
  "analyze.model": "Model tier for decompose and classify",
  "analyze.fallbackToKeywords": "Fall back to keyword matching on LLM failure",
  "analyze.maxCodebaseSummaryTokens": "Max tokens for codebase summary",

  // Review
  "review": "Review phase configuration",
  "review.enabled": "Enable review phase",
  "review.checks": "List of checks to run (typecheck, lint, test)",
  "review.commands": "Custom commands per check",
  "review.commands.typecheck": "Custom typecheck command for review",
  "review.commands.lint": "Custom lint command for review",
  "review.commands.test": "Custom test command for review",

  // Plan
  "plan": "Planning phase configuration",
  "plan.model": "Model tier for planning",
  "plan.outputPath": "Output path for generated spec (relative to nax/)",

  // Acceptance
  "acceptance": "Acceptance test configuration",
  "acceptance.enabled": "Enable acceptance test generation and validation",
  "acceptance.maxRetries": "Max retry loops for fix stories",
  "acceptance.generateTests": "Generate acceptance tests during analyze",
  "acceptance.testPath": "Path to acceptance test file (relative to feature dir)",

  // Context
  "context": "Context injection configuration",
  "context.testCoverage": "Test coverage context settings",
  "context.testCoverage.enabled": "Enable test coverage context injection",
  "context.testCoverage.detail": "Detail level: names-only | names-and-counts | describe-blocks",
  "context.testCoverage.maxTokens": "Max tokens for test summary",
  "context.testCoverage.testDir": "Test directory relative to workdir",
  "context.testCoverage.testPattern": "Glob pattern for test files",
  "context.testCoverage.scopeToStory": "Scope test coverage to story-relevant files only",
  "context.autoDetect": "Auto-detect relevant files settings",
  "context.autoDetect.enabled": "Enable auto-detection of relevant files",
  "context.autoDetect.maxFiles": "Max files to auto-detect",
  "context.autoDetect.traceImports": "Trace imports to find related files",

  // Optimizer
  "optimizer": "Prompt optimizer configuration",
  "optimizer.enabled": "Enable prompt optimizer",
  "optimizer.strategy": "Optimization strategy: rule-based | llm | noop",

  // Plugins
  "plugins": "Plugin configurations",

  // Hooks
  "hooks": "Hooks configuration",
  "hooks.skipGlobal": "Skip loading global hooks",

  // Interaction
  "interaction": "Interaction plugin configuration",
  "interaction.plugin": "Plugin to use for interactions (default: cli)",
  "interaction.config": "Plugin-specific configuration",
  "interaction.defaults": "Default interaction settings",
  "interaction.defaults.timeout": "Default timeout in milliseconds",
  "interaction.defaults.fallback": "Default fallback behavior: continue | skip | escalate | abort",
  "interaction.triggers": "Enable/disable built-in triggers",

  // Precheck
  "precheck": "Precheck configuration (run before analysis)",
  "precheck.storySizeGate": "Story size gate settings",
  "precheck.storySizeGate.enabled": "Enable story size gate",
  "precheck.storySizeGate.maxAcCount": "Max acceptance criteria count before flagging",
  "precheck.storySizeGate.maxDescriptionLength": "Max description character length before flagging",
  "precheck.storySizeGate.maxBulletPoints": "Max bullet point count before flagging",
};

/** Options for config command */
export interface ConfigCommandOptions {
  /** Show field explanations */
  explain?: boolean;
}

/**
 * Display effective configuration with optional explanations.
 *
 * @param config - Loaded configuration
 * @param options - Command options
 */
export async function configCommand(config: NaxConfig, options: ConfigCommandOptions = {}): Promise<void> {
  const { explain = false } = options;

  // Determine sources
  const sources = await determineConfigSources();

  if (explain) {
    console.log("# nax Configuration");
    console.log("#");
    console.log("# Resolution order: defaults → global → project → CLI overrides");
    console.log(`# Global config: ${sources.global ? sources.global : "(not found)"}`);
    console.log(`# Project config: ${sources.project ? sources.project : "(not found)"}`);
    console.log();

    // Recursively display config with descriptions
    displayConfigWithDescriptions(config, [], sources);
  } else {
    // Simple JSON output
    console.log(JSON.stringify(config, null, 2));
  }
}

/**
 * Determine which config files are present.
 *
 * @returns Paths to global and project config files (null if not found)
 */
async function determineConfigSources(): Promise<{ global: string | null; project: string | null }> {
  const globalPath = globalConfigPath();
  const projectDir = findProjectDir();
  const projectPath = projectDir ? join(projectDir, "config.json") : null;

  return {
    global: existsSync(globalPath) ? globalPath : null,
    project: projectPath && existsSync(projectPath) ? projectPath : null,
  };
}

/**
 * Display configuration with descriptions and source annotations.
 *
 * @param obj - Configuration object or value
 * @param path - Current path in config tree
 * @param sources - Config source paths
 * @param indent - Current indentation level
 */
function displayConfigWithDescriptions(
  obj: unknown,
  path: string[],
  sources: { global: string | null; project: string | null },
  indent = 0,
): void {
  const indentStr = "  ".repeat(indent);
  const pathStr = path.join(".");

  // Handle primitives and arrays
  if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
    const description = FIELD_DESCRIPTIONS[pathStr];
    const value = formatValue(obj);

    if (description) {
      console.log(`${indentStr}# ${description}`);
    }

    const key = path[path.length - 1] || "";
    console.log(`${indentStr}${key}: ${value}`);
    console.log();
    return;
  }

  // Handle objects
  const entries = Object.entries(obj as Record<string, unknown>);

  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    const currentPath = [...path, key];
    const currentPathStr = currentPath.join(".");
    const description = FIELD_DESCRIPTIONS[currentPathStr];

    // Display description comment if available
    if (description) {
      console.log(`${indentStr}# ${description}`);
    }

    // Handle nested objects
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      console.log(`${indentStr}${key}:`);
      displayConfigWithDescriptions(value, currentPath, sources, indent + 1);
    } else {
      // Display value
      const formattedValue = formatValue(value);
      console.log(`${indentStr}${key}: ${formattedValue}`);

      // Add blank line after each top-level section
      if (indent === 0 && i < entries.length - 1) {
        console.log();
      }
    }
  }
}

/**
 * Format a config value for display.
 *
 * @param value - Value to format
 * @returns Formatted string
 */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3) {
      return `[${value.map((v) => formatValue(v)).join(", ")}]`;
    }
    return `[${value.slice(0, 3).map((v) => formatValue(v)).join(", ")}, ... (${value.length} items)]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
