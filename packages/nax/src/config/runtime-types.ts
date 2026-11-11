/**
 * Runtime Configuration Type Definitions
 *
 * All configuration interfaces for nax runtime behavior,
 * including execution limits, quality gates, and feature settings.
 */

import type { QualityCommandSpec, SandboxConfig } from "@nathapp/nax-agent/internal";
import type { ConstitutionConfig } from "@/constitution/types";
import type { ReviewConfig } from "@/review/types";
import type { AgentConfig, GenerateConfig } from "./runtime-types-agent";
import type { AutoRouteConfig } from "./runtime-types-auto-route";
import type { ContextConfig } from "./runtime-types-context";
import type {
  CommandInterceptorConfig,
  InstallConfig,
  PreRunStepConfig,
  SmartTestRunnerConfig,
} from "./runtime-types-execution";
import type {
  Complexity,
  ComplexityRung,
  ConfiguredModel,
  LlmRoutingMode,
  ModelsConfig,
  RoutingStrategyName,
  TddStrategy,
} from "./schema-types";
import type { AuthConfig } from "./schemas-auth";
import type { CommandSafetyConfig } from "./schemas-command-safety";
import type { AgentRoutingConfig } from "./schemas-infra";
import type { StoryRouterConfig } from "./schemas-router";

export interface EscalationEntry {
  from: string;
  to: string;
}

/** Auto mode configuration */
export interface AutoModeConfig {
  complexityRouting: Record<Complexity, ComplexityRung>; // Rung per complexity; { tier, agent } names a cross-agent rung
  escalation: {
    enabled: boolean;
    tierOrder: Array<{ tier: string; attempts: number; agent?: string }>; // Ordered tier escalation with per-tier attempt budgets
    escalateEntireBatch?: boolean; // When a batch fails, escalate all stories in the batch (default: true)
    resetMode: "initial" | "last"; // Reset behaviour for failed stories on re-run (ADR-025)
  };
}

/** Rectification config — unified cap for story-orchestrator + regression cycles. */
export interface RectificationConfig {
  /** Total iteration cap for the unified fix cycle. Per-strategy caps are the
   * granular bound; this is the loose ceiling. (default: 12) */
  maxAttemptsTotal: number;
  /** Timeout for full test suite run in seconds (default: 120) */
  fullSuiteTimeoutSeconds: number;
}

/** Regression gate config (BUG-009, BUG-026) */
export interface RegressionGateConfig {
  /** Enable full-suite regression gate after scoped verification (default: true) */
  enabled: boolean;
  /** Timeout for full-suite regression run in seconds (default: 120) */
  timeoutSeconds: number;
  /** Accept timeout as pass instead of failing (BUG-026, default: true) */
  acceptOnTimeout?: boolean;
}

export type { SmartTestRunnerConfig } from "./runtime-types-execution";

/** Execution limits */
export interface ExecutionConfig {
  /** A5: "workflow" swaps the story pipeline for the workflow loop. */
  mode: import("./runtime-types-workflow").ExecutionMode;
  /** Delay between iterations (ms) */
  iterationDelayMs: number;
  /** Max cost (USD) before pausing */
  costLimit: number;
  /** Timeout per agent coding session (seconds) */
  sessionTimeoutSeconds: number;
  /** Max retries for non-retryable session errors (e.g. stale/locked session). Default: 1. */
  sessionErrorMaxRetries: number;
  /** Max retries for retryable session errors (e.g. QUEUE_DISCONNECTED_BEFORE_COMPLETION). Default: 3. */
  sessionErrorRetryableMaxRetries: number;
  /** Max stories per feature (prevents memory exhaustion) */
  maxStoriesPerFeature: number;
  /** Rectification loop settings (v0.11) */
  rectification: RectificationConfig;
  /** Regression gate settings (BUG-009) */
  regressionGate: RegressionGateConfig;
  /** Token budget for plugin context providers (default: 2000) */
  contextProviderTokenBudget: number;
  /** Native context compaction settings, resolved as percentages of the model's window. */
  compaction: { enabled: boolean; compactAtPercent: number; keepRecentPercent: number };
  /** Test command override (null = disabled, undefined = auto-detect from package.json) */
  testCommand?: string | null;
  /** Lint command override (null = disabled, undefined = auto-detect from package.json) */
  lintCommand?: string | null;
  /** Typecheck command override (null = disabled, undefined = auto-detect from package.json) */
  typecheckCommand?: string | null;
  /** Permission profile for the agent (default: "unrestricted") */
  permissionProfile?: "unrestricted" | "safe" | "scoped";
  /** ADR-030. Global default; `permissions.<stage>.bashApproval` overrides it. */
  bashApproval?: "raw" | "gated" | "escalate";
  /** P2. Milliseconds a permission prompt waits before denying. */
  approvalTimeout?: number;
  /** P4: OS sandbox for agent-authored commands. */
  sandbox?: SandboxConfig;
  /** P5: shadow command classifier; absent = off. */
  commandSafety?: CommandSafetyConfig;
  /** Per-stage tool policy (GitHub #374). Read by resolveScopedPermissions; enforced by packages/nax-agent/src/tools/. */
  permissions?: Record<
    string,
    {
      // Declares the vocabulary the SSOT resolver reads; decides nothing.
      mode?: "approve-all" | "approve-reads" | "scoped"; // nax-permission-mode-allow: type declares the field's accepted values, resolvePermissions decides
      allowedTools?: string[];
      inherit?: string;
      bashApproval?: "raw" | "gated" | "escalate";
    }
  >;
  /** Enable smart test runner to scope test runs to changed files (default: true).
   * Accepts boolean for backward compat or a SmartTestRunnerConfig object. */
  smartTestRunner?: boolean | SmartTestRunnerConfig;
  preRun: PreRunStepConfig[];
  /** Configured agent binary: claude, codex, opencode, gemini, aider (default: claude) */
  agent?: string;
  /** Git HEAD ref captured before agent ran — passed through pipeline for plugin reviewers (FEAT-010) */
  storyGitRef?: string;
  /** Command interception (rtk git-site) — opt-in; installed into the Git tool seam at run setup. */
  commandInterceptor: CommandInterceptorConfig;
  /** Glob denylist narrowing Delete beyond tracked/gitignored (nax#1972). */
  denyPaths?: string[];
}

export type { InstallConfig } from "./runtime-types-execution";

/** Quality gate config */
export interface QualityConfig {
  /** Threshold for scoped test strategy — when changed source files exceed this count, fall back to full suite */
  scopeTestThreshold?: number;
  /** Custom quality commands */
  commands: {
    typecheck?: QualityCommandSpec;
    lint?: QualityCommandSpec;
    /** Scoped lint command template with {{files}} placeholder (e.g., "biome check {{files}}") */
    lintScoped?: QualityCommandSpec;
    test?: QualityCommandSpec;
    /** Scoped test command template with {{files}} placeholder (e.g., "bun test --timeout=60000 {{files}}") */
    testScoped?: QualityCommandSpec;
    build?: QualityCommandSpec;
    /** Host-side e2e journey gate (#2530); last in the gate order. */
    e2e?: QualityCommandSpec;
    /** One-time host bootstrap for `e2e`; a setup without `e2e` declares no gate. */
    e2eSetup?: QualityCommandSpec;
    /** Coverage gate (e.g. "bun run test:coverage"); agent affordance, never invoked by nax. */
    coverage?: QualityCommandSpec;
    /** One-time package init (e.g. "uv sync"/"bun install"); see schema for full docs. */
    setup?: QualityCommandSpec;
  };
  /** Lint output parsing preferences for scope-aware rectification splitting. */
  lintOutput?: {
    /** Parsing mode: auto-detect (default), specific parser, or disabled fallback. */
    format?: "auto" | "eslint-json" | "biome-json" | "text" | "none";
  };
  /** Append --forceExit to test command to prevent open handle hangs (default: false) */
  forceExit: boolean;
  /** Append --detectOpenHandles on timeout retry to diagnose hangs (default: true) */
  detectOpenHandles: boolean;
  /** Max retries with --detectOpenHandles before falling back to --forceExit (default: 1) */
  detectOpenHandlesRetries: number;
  /** Grace period in ms after SIGTERM before sending SIGKILL (default: 5000) */
  gracePeriodMs: number;
  /** Deadline in ms to drain stdout/stderr after killing process (Bun stream workaround, default: 2000) */
  drainTimeoutMs: number;
  /** Shell to use for running verification commands (default: /bin/sh) */
  shell: string;
  /** Environment variables to strip during verification (prevents AI-optimized output) */
  stripEnvVars: string[];
}

/** TDD config */
export interface TddConfig {
  /** TDD strategy override (default: 'auto') */
  strategy: TddStrategy;
  /** Enable greenfield detection to force tdd-simple on projects with no test files (default: true, BUG-010) */
  greenfieldDetection?: boolean;
}

// Re-exported from constitution/types.ts to maintain single source of truth
export type { ConstitutionConfig } from "@/constitution/types";

// Re-exported from review/types.ts to maintain single source of truth
export type { AdversarialReviewConfig, ReviewConfig } from "@/review/types";

/** Plan config */
export interface PlanConfig {
  /** Model selector for planning (tier string or explicit { agent, model }) */
  model: ConfiguredModel;
  /** Timeout for plan sessions in seconds (default: 600) */
  timeoutSeconds?: number;
  /** Override timeout for decompose calls in seconds. Defaults to plan.timeoutSeconds. */
  decomposeTimeoutSeconds?: number;
  /** Orchestration mode. Resolved at runtime when absent; see resolvePlanMode(). */
  mode?: "single" | "refine";
  /**
   * When true, the refine hopBody runs a deterministic spec-drift check after
   * Turn 2 and issues a repair turn if violations are found. Default: false.
   */
  specGuard?: boolean;
}

export interface PluginConfigEntry {
  module: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

/** Interaction config (v0.15.0) */
export interface InteractionConfig {
  /** Plugin to use for interactions (default: "cli") */
  plugin: string;
  /** Plugin-specific configuration */
  config?: Record<string, unknown>;
  /** Default settings */
  defaults: {
    /** Default timeout in milliseconds (default: 600000 = 10 minutes) */
    timeout: number;
    /** Delay before offering a terminal approval to the interaction chain (default: 60000). */
    chatAskFallbackMs?: number;
    chatTaskNoticeTurns?: number; // ended-task notices that may wake the chat agent in a row (default: 3)
    /**
     * Global fallback override. Undefined unless the operator explicitly set it (BUG-48 / D-9) — a
     * schema-level default here would make every trigger's fallback identical, silently overriding each
     * trigger's own metadata default (see TRIGGER_METADATA). Ignored for red-tier triggers.
     */
    fallback?: "continue" | "skip" | "escalate" | "abort";
  };
  /** Enable/disable built-in triggers */
  triggers: Partial<
    Record<
      string,
      | boolean
      | {
          enabled: boolean;
          fallback?: "continue" | "skip" | "escalate" | "abort";
          timeout?: number;
          threshold?: number;
        }
    >
  >;
}

export type {
  ContextAutoDetectConfig,
  ContextConfig,
  ContextPluginProviderConfig,
  ContextProjectContextConfig,
  ContextRulesOverrideConfig,
  ContextV2Config,
  ContextV2PullConfig,
  ContextV2RulesConfig,
  FeatureContextEngineConfig,
  TestCoverageConfig,
} from "./runtime-types-context";

/** Story size gate thresholds (v0.16.0) */
export interface StorySizeGateConfig {
  /** Enable story size gate (default: true) */
  enabled: boolean;
  /** Max acceptance criteria count before flagging (default: 10) */
  maxAcCount: number;
  /** Max description character length before flagging (default: 3000) */
  maxDescriptionLength: number;
  /** Max bullet point count before flagging (default: 12) */
  maxBulletPoints: number;
  /** Action when stories exceed thresholds: 'block' (fail-fast), 'warn' (non-blocking), 'skip' (disabled) */
  action: "block" | "warn" | "skip";
  /** Max number of replan attempts before escalating (default: 3) */
  maxReplanAttempts: number;
}

/** Precheck configuration (v0.16.0) */
export interface PrecheckConfig {
  /** Story size gate settings */
  storySizeGate: StorySizeGateConfig;
}

/** LLM routing config */
export interface LlmRoutingConfig {
  /** Model selector for routing call (tier string or explicit { agent, model }) */
  model?: ConfiguredModel;
  /** Fall back to keyword strategy on LLM failure (default: true) */
  fallbackToKeywords?: boolean;
  /** Max input tokens for story context (default: 2000) */
  /** Cache routing decisions per story ID (default: true) */
  cacheDecisions?: boolean;
  /** Routing mode (default: "hybrid")
   * - "one-shot": batch-route ALL pending stories once at run start, use keyword fallback on cache miss
   * - "per-story": route each story individually just before execution (max LLM calls = N stories)
   * - "hybrid": batch-route upfront, re-route individually on retry/failure (best quality + cost balance)
   */
  mode?: LlmRoutingMode;
  /** Number of retries on LLM timeout or transient failure (default: 1) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelayMs?: number;
}

/** Routing config */
export interface RoutingConfig {
  /** Strategy to use (default: "keyword") */
  strategy: RoutingStrategyName;
  /** LLM routing settings (used when strategy = "llm") */
  llm?: LlmRoutingConfig;
  /** Agent routing settings (plan-time agent selection) */
  agents?: AgentRoutingConfig;
  /** Opt-in story router settings */
  router?: StoryRouterConfig;
}

export type { FinishConfig, FinishTimeoutsConfig } from "./runtime-types-finish";
export type { McpConfig, McpServerConfig, McpStage } from "./runtime-types-mcp";
export type { ProjectProfile } from "./runtime-types-project";
/** Full nax configuration */
export interface NaxConfig {
  /** Global-only credential source configuration. */
  auth?: AuthConfig;
  /** Project name — used as the default projectKey for output directory. Lowercase alphanumeric, hyphens, underscores. */
  name: string;
  /** Output directory override — absolute path or ~/path. If absent, defaults to ~/.nax/<projectKey> */
  outputDir?: string;
  /** Schema version */
  version: 1;
  /** Model mapping — per-agent tier map: Record<agentName, Record<tierName, ModelEntry>> */
  models: ModelsConfig;
  /** Auto mode / routing config */
  autoMode: AutoModeConfig;
  autoRoute: AutoRouteConfig; // Auto route calibration config
  /** Routing strategy config */
  routing: RoutingConfig;
  /** Execution limits */
  execution: ExecutionConfig;
  /** Lifecycle-script gate for agent-triggered installs */
  install: InstallConfig;
  /** Quality gates */
  quality: QualityConfig;
  /** TDD settings */
  tdd: TddConfig;
  /** Constitution settings */
  constitution: ConstitutionConfig;
  /** Review settings */
  review: ReviewConfig;
  /** Plan settings */
  plan: PlanConfig;
  /** Context injection settings */
  context: ContextConfig;
  /** Plugin configurations (v0.10) */
  plugins?: PluginConfigEntry[];
  /** Disabled plugin names (v0.38.2) */
  disabledPlugins?: string[];
  /** Built-in reporter plugin settings (webhook / OTel) */
  reporters?: import("./schemas-reporters").ReportersConfig;
  /** nax-finish autonomous finish flow settings */
  finish?: import("./runtime-types-finish").FinishConfig;
  /** A1 advisor (rules on judgment calls instead of stopping the run) */
  advisor?: import("./runtime-types-advisor").AdvisorConfig;
  /** A5 workflow mode (single implementer + bounded review loop); root-only */
  workflow?: import("./runtime-types-workflow").WorkflowConfig;
  bot?: import("./runtime-types-bot").BotConfig;
  /** External MCP servers the native agent may call tools on (client only) */
  mcp?: import("./runtime-types-mcp").McpConfig;
  memory?: import("./runtime-types-memory").MemoryConfig;
  /** Resource discovery and skills delivery settings; absent means schema defaults. */
  resources?: import("./schemas-resources").ResourcesConfig;
  /** Interaction settings (v0.15.0) */
  interaction?: InteractionConfig;
  /** Precheck settings (v0.16.0) */
  precheck?: PrecheckConfig;
  /** Prompt settings */
  /** Agent protocol settings (ACP-003) */
  agent?: AgentConfig;
  /** Generate settings */
  generate?: GenerateConfig;
  /** Project profile — language and tooling metadata (US-001) */
  project?: import("./runtime-types-project").ProjectProfile;
  autoPr: import("./runtime-types-autopr").AutoPrConfig;
  /** Configuration profile name. For a multi-profile chain this is the composite, e.g. "a+b" (default: "default") */
  profile: string;
  /** Ordered profile overlays (later wins), excluding implicit "default"; empty when none applied. */
  profileChain?: string[];
}
export type {
  AgentAcpConfig,
  AgentConfig,
  AgentFallbackConfig,
  AgentTimeoutRetryConfig,
  GenerateConfig,
  IdleWatchdogConfig,
  PromptAuditConfig,
  TranscriptAuditConfig,
  UsageAuditConfig,
} from "./runtime-types-agent";
