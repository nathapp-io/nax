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
  models:
    "Per-agent model map defining tier assignments. Maps agent names to their available tiers (fast/balanced/powerful). Example: { claude: { fast: 'haiku', balanced: 'sonnet', powerful: 'opus' } }",
  "models.claude": "Claude agent tier definitions (fast/balanced/powerful)",
  "models.claude.fast": "Fast model for lightweight tasks (e.g., haiku)",
  "models.claude.balanced": "Balanced model for general coding (e.g., sonnet)",
  "models.claude.powerful": "Powerful model for complex tasks (e.g., opus)",

  // Auto mode
  autoMode:
    "Auto mode configuration for agent orchestration. Enables multi-agent routing with model tier selection per task complexity and escalation on failures.",
  "autoMode.enabled": "Enable automatic agent selection and escalation",
  "autoMode.defaultAgent":
    "Default agent to use when no specific agent is requested. Examples: 'claude' (Claude Code), 'codex' (GitHub Copilot), 'opencode' (OpenCode). The agent handles the main coding tasks.",
  "autoMode.fallbackOrder":
    'Fallback order for per-agent selection when the primary agent is rate-limited, unavailable, or fails. Specifies which agents in the per-agent model map to try in sequence. Example: ["claude", "codex"] means try Claude first, then Copilot. Each agent must have tiers defined in the models per-agent map.',
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
  "execution.rectification.escalateOnExhaustion":
    "Enable model tier escalation when retries are exhausted with remaining failures",
  "execution.rectification.rethinkAtAttempt":
    "Attempt number at which 'rethink your approach' language is injected into the prompt (default: 2, set >= maxRetries to disable)",
  "execution.rectification.urgencyAtAttempt":
    "Attempt number at which 'final chance before escalation' urgency is added to the prompt (default: 3, set >= maxRetries to disable)",
  "execution.regressionGate": "Regression gate settings (full suite after scoped tests)",
  "execution.regressionGate.enabled": "Enable full-suite regression gate",
  "execution.regressionGate.timeoutSeconds": "Timeout for regression run in seconds",
  "execution.storyIsolation":
    'Story isolation mode. "shared" (default): all stories run on the main branch. "worktree": each story runs in an isolated git worktree (.nax-wt/<storyId>/); passed stories merge into main, failed commits never reach main.',

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
  "review.semantic.diffMode":
    "How the semantic reviewer accesses the git diff. 'embedded' (default) includes the diff in the prompt (truncated at 50KB). 'ref' passes only the git ref and file list — the reviewer fetches the full diff via tools. Use 'ref' for large stories or multi-tier escalations where truncation loses context.",
  "review.semantic.resetRefOnRerun":
    "When true, clears storyGitRef on failed stories during re-run initialization so the ref is re-captured at the next story start. Prevents cross-story diff pollution when multiple stories exhaust all tiers and are re-run. Default: false.",
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
  "acceptance.command":
    "Override command to run acceptance tests. Use {{FILE}} as placeholder for the test file path (default: 'bun test {{FILE}} --timeout=60000')",
  "acceptance.model":
    "Model tier for acceptance generation/refinement LLM calls (fast | balanced | powerful). Default: fast.",
  "acceptance.refinement":
    "Enable acceptance criteria refinement step before execution (default: true). Disable to skip refinement and use generated criteria as-is.",
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
  "precheck.storySizeGate.action":
    "Action when stories exceed size thresholds: 'block' (fail-fast, Tier 1), 'warn' (non-blocking, Tier 2), 'skip' (disable gate)",
  "precheck.storySizeGate.maxReplanAttempts": "Max replan attempts before escalating (default: 3)",

  // Prompts
  prompts: "Prompt template overrides (PB-003: PromptBuilder)",
  "prompts.overrides": "Custom prompt template files for specific roles",
  "prompts.overrides.test-writer": 'Path to custom test-writer prompt (e.g., ".nax/prompts/test-writer.md")',
  "prompts.overrides.implementer": 'Path to custom implementer prompt (e.g., ".nax/prompts/implementer.md")',
  "prompts.overrides.verifier": 'Path to custom verifier prompt (e.g., ".nax/prompts/verifier.md")',
  "prompts.overrides.single-session": 'Path to custom single-session prompt (e.g., ".nax/prompts/single-session.md")',

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

  // Debate (US-001)
  debate: "Multi-agent debate configuration — run multiple agents in parallel to improve output quality",
  "debate.enabled": "Enable multi-agent debate globally (default: false)",
  "debate.agents":
    "Default number of debating agents when no explicit debaters array is specified (default: 3, min: 2)",
  "debate.stages": "Per-stage debate configuration",
  "debate.stages.plan":
    "Debate settings for the planning stage (default: stateful, synthesis resolver, 3 rounds, enabled)",
  "debate.stages.review":
    "Debate settings for the review stage (default: one-shot, majority-fail-closed, 2 rounds, enabled)",
  "debate.stages.acceptance":
    "Debate settings for the acceptance test stage (default: one-shot, majority-fail-closed, 1 round, disabled)",
  "debate.stages.rectification":
    "Debate settings for the rectification loop (default: one-shot, synthesis, 1 round, disabled)",
  "debate.stages.escalation":
    "Debate settings for the escalation phase (default: one-shot, majority-fail-closed, 1 round, disabled)",
  "debate.stages.plan.enabled": "Enable debate for this stage",
  "debate.stages.plan.resolver": "Resolver configuration — how debate outcomes are determined",
  "debate.stages.plan.resolver.type":
    "Resolver strategy: 'synthesis' (LLM synthesises all outputs) | 'majority-fail-closed' (majority vote, ties fail) | 'majority-fail-open' (majority vote, ties pass) | 'custom'",
  "debate.stages.plan.resolver.agent":
    "Agent used as resolver — resolved from config.autoMode.defaultAgent when absent",
  "debate.stages.plan.resolver.tieBreaker": "Tie-breaker strategy when votes are tied",
  "debate.stages.plan.resolver.maxPromptTokens": "Max prompt tokens passed to the resolver agent",
  "debate.stages.plan.sessionMode":
    "Session mode: 'stateful' (agents maintain context across rounds) | 'one-shot' (fresh session per round)",
  "debate.stages.plan.rounds": "Number of debate rounds (min: 1)",
  "debate.stages.plan.debaters":
    "Optional array of debater agents (min 2 entries). Resolved from config.autoMode.defaultAgent when absent.",
  "debate.stages.plan.debaters[].agent": "Agent name (e.g. 'claude', 'opencode')",
  "debate.stages.plan.debaters[].model":
    "Optional model override — resolved from config.models.fast at runtime when absent",
};
