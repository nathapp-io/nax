/**
 * Configuration Field Descriptions
 *
 * Human-readable descriptions for all configuration fields.
 * Extracted from config-display.ts for better maintainability.
 */

export const FIELD_DESCRIPTIONS: Record<string, string> = {
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
  "quality.commands.build": "Custom build command",
  "quality.forceExit": "Append --forceExit to test command (prevents hangs)",
  "quality.detectOpenHandles": "Append --detectOpenHandles on timeout",
  "quality.detectOpenHandlesRetries": "Max retries with --detectOpenHandles",
  "quality.gracePeriodMs": "Grace period in ms after SIGTERM before SIGKILL",
  "quality.drainTimeoutMs": "Deadline in ms to drain stdout/stderr after kill",
  "quality.shell": "Shell to use for verification commands",
  "quality.stripEnvVars": "Environment variables to strip during verification",

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
  "review.checks": "List of checks to run (typecheck, lint, test, build, semantic)",
  "review.commands": "Custom commands per check",
  "review.commands.typecheck": "Custom typecheck command for review",
  "review.commands.lint": "Custom lint command for review",
  "review.commands.test": "Custom test command for review",
  "review.commands.build": "Custom build command for review",
  "review.semantic": "Semantic review configuration (code quality analysis)",
  "review.semantic.modelTier": "Model tier for semantic review (default: balanced)",
  "review.semantic.rules": "Custom semantic review rules to enforce",

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
  "acceptance.timeoutMs": "Timeout for acceptance test generation in milliseconds (default: 1800000 = 30 min)",

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

  // Agent protocol
  agent: "Agent protocol configuration (ACP-003)",
  "agent.protocol": "Protocol for agent communication: 'acp' | 'cli' (default: 'acp')",
  "agent.maxInteractionTurns":
    "Max turns in multi-turn interaction loop when interactionBridge is active (default: 10)",
  // quality.testing (ENH-010) — per-package overridable
  "quality.testing": "Hermetic test enforcement — per-package overridable (ENH-010)",
  "quality.testing.hermetic":
    "Inject hermetic test requirement into prompts — never call real external services in tests (default: true)",
  "quality.testing.externalBoundaries": "Project-specific CLI tools/clients to mock (e.g. ['claude', 'acpx', 'redis'])",
  "quality.testing.mockGuidance": "Project-specific mocking guidance injected verbatim into the prompt",
};
