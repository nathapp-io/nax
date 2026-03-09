/**
 * Config Command
 *
 * Displays effective merged configuration with inline explanations.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults";
import { findProjectDir, globalConfigPath } from "../config/loader";
import { deepMergeConfig } from "../config/merger";
import type { NaxConfig } from "../config/schema";

/** Field descriptions for human-readable output */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  // Top-level
  version: "Configuration schema version",

  // Models
  models: "Model tier definitions (fast/balanced/powerful)",
  "models.fast": "Fast model for lightweight tasks (e.g., haiku)",
  "models.balanced": "Balanced model for general coding (e.g., sonnet)",
  "models.powerful": "Powerful model for complex tasks (e.g., opus)",

  // Auto mode
  autoMode:
    "Auto mode configuration for agent orchestration. Enables multi-agent routing with model tier selection per task complexity and escalation on failures.",
  "autoMode.enabled": "Enable automatic agent selection and escalation",
  "autoMode.defaultAgent":
    "Default agent to use when no specific agent is requested. Examples: 'claude' (Claude Code), 'codex' (GitHub Copilot), 'opencode' (OpenCode). The agent handles the main coding tasks.",
  "autoMode.fallbackOrder":
    'Fallback order for agent selection when the primary agent is rate-limited, unavailable, or fails. Tries each agent in sequence until one succeeds. Example: ["claude", "codex", "opencode"] means try Claude first, then Copilot, then OpenCode.',
  "autoMode.complexityRouting":
    "Model tier routing rules mapped to story complexity levels. Determines which model (fast/balanced/powerful) to use based on task complexity: simple → fast, medium → balanced, complex → powerful, expert → powerful.",
  "autoMode.complexityRouting.simple": "Model tier for simple tasks (low complexity, straightforward changes)",
  "autoMode.complexityRouting.medium": "Model tier for medium tasks (moderate complexity, multi-file changes)",
  "autoMode.complexityRouting.complex": "Model tier for complex tasks (high complexity, architectural decisions)",
  "autoMode.complexityRouting.expert":
    "Model tier for expert tasks (highest complexity, novel problems, design patterns)",
  "autoMode.escalation":
    "Escalation settings for failed stories. When a story fails after max attempts at current tier, escalate to the next tier in tierOrder. Enables progressive use of more powerful models.",
  "autoMode.escalation.enabled": "Enable tier escalation on failure",
  "autoMode.escalation.tierOrder":
    'Ordered tier escalation chain with per-tier attempt budgets. Format: [{"tier": "fast", "attempts": 2}, {"tier": "balanced", "attempts": 2}, {"tier": "powerful", "attempts": 1}]. Allows each tier to attempt fixes before escalating to the next.',
  "autoMode.escalation.escalateEntireBatch":
    "When enabled, escalate all stories in a batch if one fails. When disabled, only the failing story escalates (allows parallel attempts at different tiers).",

  // Routing
  routing: "Model routing strategy configuration",
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
  execution: "Execution limits and timeouts",
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
  quality: "Quality gate configuration",
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
  tdd: "Test-driven development configuration",
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
  constitution: "Constitution settings (core rules and constraints)",
  "constitution.enabled": "Enable constitution loading and injection",
  "constitution.path": "Path to constitution file (relative to nax/ directory)",
  "constitution.maxTokens": "Maximum tokens allowed for constitution content",
  "constitution.skipGlobal": "Skip loading global constitution",

  // Analyze
  analyze: "Feature analysis settings",
  "analyze.llmEnhanced": "Enable LLM-enhanced analysis",
  "analyze.model": "Model tier for decompose and classify",
  "analyze.fallbackToKeywords": "Fall back to keyword matching on LLM failure",
  "analyze.maxCodebaseSummaryTokens": "Max tokens for codebase summary",

  // Review
  review: "Review phase configuration",
  "review.enabled": "Enable review phase",
  "review.checks": "List of checks to run (typecheck, lint, test)",
  "review.commands": "Custom commands per check",
  "review.commands.typecheck": "Custom typecheck command for review",
  "review.commands.lint": "Custom lint command for review",
  "review.commands.test": "Custom test command for review",

  // Plan
  plan: "Planning phase configuration",
  "plan.model": "Model tier for planning",
  "plan.outputPath": "Output path for generated spec (relative to nax/)",

  // Acceptance
  acceptance: "Acceptance test configuration",
  "acceptance.enabled": "Enable acceptance test generation and validation",
  "acceptance.maxRetries": "Max retry loops for fix stories",
  "acceptance.generateTests": "Generate acceptance tests during analyze",
  "acceptance.testPath": "Path to acceptance test file (relative to feature dir)",

  // Context
  context: "Context injection configuration",
  "context.fileInjection":
    "Mode: 'disabled' (default, MCP-aware agents pull context on-demand) | 'keyword' (legacy git-grep injection for non-MCP agents). Set context.fileInjection in config.",
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
  optimizer: "Prompt optimizer configuration",
  "optimizer.enabled": "Enable prompt optimizer",
  "optimizer.strategy": "Optimization strategy: rule-based | llm | noop",

  // Plugins
  plugins: "Plugin configurations",

  // Hooks
  hooks: "Hooks configuration",
  "hooks.skipGlobal": "Skip loading global hooks",

  // Interaction
  interaction: "Interaction plugin configuration",
  "interaction.plugin": "Plugin to use for interactions (default: cli)",
  "interaction.config": "Plugin-specific configuration",
  "interaction.defaults": "Default interaction settings",
  "interaction.defaults.timeout": "Default timeout in milliseconds",
  "interaction.defaults.fallback": "Default fallback behavior: continue | skip | escalate | abort",
  "interaction.triggers": "Enable/disable built-in triggers",

  // Precheck
  precheck: "Precheck configuration (run before analysis)",
  "precheck.storySizeGate": "Story size gate settings",
  "precheck.storySizeGate.enabled": "Enable story size gate",
  "precheck.storySizeGate.maxAcCount": "Max acceptance criteria count before flagging",
  "precheck.storySizeGate.maxDescriptionLength": "Max description character length before flagging",
  "precheck.storySizeGate.maxBulletPoints": "Max bullet point count before flagging",

  // Prompts
  prompts: "Prompt template overrides (PB-003: PromptBuilder)",
  "prompts.overrides": "Custom prompt template files for specific roles",
  "prompts.overrides.test-writer": 'Path to custom test-writer prompt (e.g., ".nax/prompts/test-writer.md")',
  "prompts.overrides.implementer": 'Path to custom implementer prompt (e.g., ".nax/prompts/implementer.md")',
  "prompts.overrides.verifier": 'Path to custom verifier prompt (e.g., ".nax/prompts/verifier.md")',
  "prompts.overrides.single-session": 'Path to custom single-session prompt (e.g., ".nax/prompts/single-session.md")',

  // Decompose
  decompose: "Story decomposition configuration (SD-003)",
  "decompose.trigger": "Decomposition trigger mode: auto | confirm | disabled",
  "decompose.maxAcceptanceCriteria": "Max acceptance criteria before flagging as oversized (default: 6)",
  "decompose.maxSubstories": "Max number of substories to generate (default: 5)",
  "decompose.maxSubstoryComplexity": "Max complexity for any generated substory (default: 'medium')",
  "decompose.maxRetries": "Max retries on decomposition validation failure (default: 2)",
  "decompose.model": "Model tier for decomposition LLM calls (default: 'balanced')",
};

/** Options for config command */
export interface ConfigCommandOptions {
  /** Show field explanations */
  explain?: boolean;
  /** Show only fields where project overrides global */
  diff?: boolean;
}

/**
 * Load and parse a JSON config file.
 *
 * @param path - Path to config file
 * @returns Parsed config object or null if file doesn't exist
 */
async function loadConfigFile(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}

/**
 * Load global config merged with defaults.
 *
 * @returns Global config object (defaults + global overrides)
 */
async function loadGlobalConfig(): Promise<Record<string, unknown>> {
  const globalPath = globalConfigPath();
  const globalConf = await loadConfigFile(globalPath);

  if (!globalConf) {
    return structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);
  }

  return deepMergeConfig(structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>), globalConf);
}

/**
 * Load project config (raw, without defaults or global).
 *
 * @returns Project config object or null if not found
 */
async function loadProjectConfig(): Promise<Record<string, unknown> | null> {
  const projectDir = findProjectDir();
  if (!projectDir) return null;

  const projectPath = join(projectDir, "config.json");
  return await loadConfigFile(projectPath);
}

/**
 * Represents a single config field difference.
 */
interface ConfigDiff {
  /** Dot-separated field path (e.g., "execution.maxIterations") */
  path: string;
  /** Value from global config */
  globalValue: unknown;
  /** Value from project config */
  projectValue: unknown;
}

/**
 * Deep diff two config objects, returning only fields that differ.
 *
 * @param global - Global config (defaults + global overrides)
 * @param project - Project config (raw overrides only)
 * @param currentPath - Current path in object tree (for recursion)
 * @returns Array of differences
 */
function deepDiffConfigs(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
  currentPath: string[] = [],
): ConfigDiff[] {
  const diffs: ConfigDiff[] = [];

  // Iterate over project config keys (we only care about what project overrides)
  for (const key of Object.keys(project)) {
    const projectValue = project[key];
    const globalValue = global[key];
    const path = [...currentPath, key];
    const pathStr = path.join(".");

    // Handle nested objects
    if (
      projectValue !== null &&
      typeof projectValue === "object" &&
      !Array.isArray(projectValue) &&
      globalValue !== null &&
      typeof globalValue === "object" &&
      !Array.isArray(globalValue)
    ) {
      // Recurse into nested object
      const nestedDiffs = deepDiffConfigs(
        globalValue as Record<string, unknown>,
        projectValue as Record<string, unknown>,
        path,
      );
      diffs.push(...nestedDiffs);
    } else {
      // Compare primitive values or arrays
      if (!deepEqual(projectValue, globalValue)) {
        diffs.push({
          path: pathStr,
          globalValue,
          projectValue,
        });
      }
    }
  }

  return diffs;
}

/**
 * Deep equality check for two values.
 *
 * @param a - First value
 * @param b - Second value
 * @returns True if values are deeply equal
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }

  // Handle objects
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;

    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}

/**
 * Display effective configuration with optional explanations.
 *
 * @param config - Loaded configuration
 * @param options - Command options
 */
export async function configCommand(config: NaxConfig, options: ConfigCommandOptions = {}): Promise<void> {
  const { explain = false, diff = false } = options;

  // Validate mutually exclusive flags
  if (explain && diff) {
    console.error("Error: --explain and --diff are mutually exclusive");
    process.exit(1);
  }

  // Determine sources
  const sources = determineConfigSources();

  if (diff) {
    // Diff mode: show only fields where project overrides global
    const projectConf = await loadProjectConfig();

    if (!projectConf) {
      console.log("No project config found — using global defaults");
      return;
    }

    const globalConf = await loadGlobalConfig();
    const diffs = deepDiffConfigs(globalConf, projectConf);

    if (diffs.length === 0) {
      console.log("No differences between project and global config");
      return;
    }

    console.log("# Config Differences (Project overrides Global)");
    console.log();
    console.log("─".repeat(80));
    console.log(`${"Field".padEnd(40)}${"Project Value".padEnd(20)}Global Value`);
    console.log("─".repeat(80));

    for (const diff of diffs) {
      const path = diff.path.padEnd(40);
      const projectVal = formatValueForTable(diff.projectValue);
      const globalVal = formatValueForTable(diff.globalValue);

      console.log(`${path}${projectVal.padEnd(20)}${globalVal}`);

      // Show description if available
      const description = FIELD_DESCRIPTIONS[diff.path];
      if (description) {
        console.log(`${"".padEnd(40)}↳ ${description}`);
      }
    }

    console.log("─".repeat(80));
  } else if (explain) {
    console.log("# nax Configuration");
    console.log("#");
    console.log("# Resolution order: defaults → global → project → CLI overrides");
    console.log(`# Global config: ${sources.global ? sources.global : "(not found)"}`);
    console.log(`# Project config: ${sources.project ? sources.project : "(not found)"}`);
    console.log();

    // Recursively display config with descriptions
    displayConfigWithDescriptions(config, [], sources);
  } else {
    // Default view: JSON with header showing config sources
    console.log("// nax Configuration");
    console.log("// Resolution order: defaults → global → project → CLI overrides");
    console.log(`// Global config: ${sources.global ? sources.global : "(not found)"}`);
    console.log(`// Project config: ${sources.project ? sources.project : "(not found)"}`);
    console.log();
    console.log(JSON.stringify(config, null, 2));
  }
}

/**
 * Determine which config files are present.
 *
 * @returns Paths to global and project config files (null if not found)
 */
function determineConfigSources(): { global: string | null; project: string | null } {
  const globalPath = globalConfigPath();
  const projectDir = findProjectDir();
  const projectPath = projectDir ? join(projectDir, "config.json") : null;

  return {
    global: fileExists(globalPath) ? globalPath : null,
    project: projectPath && fileExists(projectPath) ? projectPath : null,
  };
}

/**
 * Check if a file exists.
 *
 * @param path - File path to check
 * @returns True if file exists, false otherwise
 */
function fileExists(path: string): boolean {
  return existsSync(path);
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

  // Special handling for prompts section: always show overrides documentation
  const objAsRecord = obj as Record<string, unknown>;
  const isPromptsSection = path.join(".") === "prompts";
  if (isPromptsSection && !objAsRecord.overrides) {
    // Add prompts.overrides documentation even if not in config
    const description = FIELD_DESCRIPTIONS["prompts.overrides"];
    if (description) {
      console.log(`${indentStr}# prompts.overrides: ${description}`);
    }

    // Show role examples
    const roles = ["test-writer", "implementer", "verifier", "single-session"];
    console.log(`${indentStr}overrides:`);
    for (const role of roles) {
      const roleDesc = FIELD_DESCRIPTIONS[`prompts.overrides.${role}`];
      if (roleDesc) {
        console.log(`${indentStr}  # ${roleDesc}`);
        // Extract the example path from description
        const match = roleDesc.match(/e\.g\., "([^"]+)"/);
        if (match) {
          console.log(`${indentStr}  # ${role}: "${match[1]}"`);
        }
      }
    }
    console.log();
    return;
  }

  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    const currentPath = [...path, key];
    const currentPathStr = currentPath.join(".");
    const description = FIELD_DESCRIPTIONS[currentPathStr];

    // Display description comment if available
    if (description) {
      // Include path for direct subsections of key configuration sections
      // (to improve clarity of important configs like multi-agent setup)
      const pathParts = currentPathStr.split(".");
      // Only show path for 2-level paths (e.g., "autoMode.enabled", "models.fast")
      // to keep deeply nested descriptions concise
      const isDirectSubsection = pathParts.length === 2;
      const isKeySection = ["prompts", "autoMode", "models", "routing"].includes(pathParts[0]);
      const shouldIncludePath = isKeySection && isDirectSubsection;
      const comment = shouldIncludePath ? `${currentPathStr}: ${description}` : description;
      console.log(`${indentStr}# ${comment}`);
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
    return `[${value
      .slice(0, 3)
      .map((v) => formatValue(v))
      .join(", ")}, ... (${value.length} items)]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Format a config value for table display (shorter format).
 *
 * @param value - Value to format
 * @returns Formatted string (max ~18 chars)
 */
function formatValueForTable(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    if (value.length > 15) {
      return `"${value.slice(0, 12)}..."`;
    }
    return `"${value}"`;
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[...${value.length}]`;
  }
  if (typeof value === "object") {
    const str = JSON.stringify(value);
    if (str.length > 15) {
      return "{...}";
    }
    return str;
  }
  return String(value);
}
