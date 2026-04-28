/**
 * Context Configuration Type Definitions
 *
 * Context-related configuration interfaces extracted from runtime-types.ts
 * to keep each file within the 600-line project limit.
 */

/** Test coverage context config */
export interface TestCoverageConfig {
  /** Enable test coverage context injection (default: true) */
  enabled: boolean;
  /** Detail level for test summary */
  detail: "names-only" | "names-and-counts" | "describe-blocks";
  /** Max tokens for the summary (default: 500) */
  maxTokens: number;
  /** Test directory relative to workdir (default: auto-detect) */
  testDir?: string;
  /** @deprecated Migrate to execution.smartTestRunner.testFilePatterns. (ADR-009) */
  testPattern?: string;
  /** Scope test coverage to story-relevant files only (default: true) */
  scopeToStory: boolean;
}

export interface ContextAutoDetectConfig {
  enabled: boolean;
  maxFiles: number;
  traceImports: boolean;
}

export interface FeatureContextEngineConfig {
  enabled: boolean;
  budgetTokens: number;
}

/** Pull tool configuration for Context Engine v2 (Phase 4+) */
export interface ContextV2PullConfig {
  /** Enable pull tools — false (default) means assemble() returns empty pullTools array */
  enabled: boolean;
  /** Tool names to activate; empty = all stage-configured tools allowed */
  allowedTools: string[];
  /** Per-session call ceiling */
  maxCallsPerSession: number;
  /** Per-run call ceiling across all sessions */
  maxCallsPerRun: number;
}

/** Canonical rules store configuration (Phase 5.1+) */
export interface ContextV2RulesConfig {
  /**
   * Fall back to CLAUDE.md + .claude/rules/ when .nax/rules/ is absent.
   * Default true during migration period; set false to enforce canonical-only.
   */
  allowLegacyClaudeMd: boolean;
  /** Token budget ceiling for canonical rules chunks. */
  budgetTokens: number;
}

/**
 * Registration entry for an external plugin provider (Phase 7+).
 * The engine loads the module and passes config to provider.init() if present.
 */
export interface ContextPluginProviderConfig {
  /** npm package name or workdir-relative path to the provider module */
  module: string;
  /** Provider-specific config, passed to provider.init(config) on load */
  config?: Record<string, unknown>;
  /** Set false to skip loading this provider (default: true) */
  enabled: boolean;
}

/** Context Engine configuration (Phase 0+) */
export interface ContextV2Config {
  /** Enable the Context Engine orchestrator — false by default (opt-in) */
  enabled: boolean;
  /**
   * Min-score threshold for noise filtering.
   * Phase 0 default: 0.1 (near-zero impact).
   */
  minScore: number;
  /** Pull tool configuration (Phase 4+) */
  pull: ContextV2PullConfig;
  /** Canonical rules store configuration (Phase 5.1+) */
  rules: ContextV2RulesConfig;
  /** External plugin providers to load (Phase 7+). Empty by default. */
  pluginProviders: ContextPluginProviderConfig[];
  /**
   * Per-stage token budget overrides (AC-59).
   * Set via per-package config (<repoRoot>/.nax/mono/<packageDir>/config.json).
   * Keys are stage names; value overrides the default stage budgetTokens.
   */
  stages: Record<string, { budgetTokens?: number; extraProviderIds?: string[] }>;
  /**
   * Determinism mode (AC-24).
   * When true, providers declaring `deterministic: false` are excluded from assembly.
   */
  deterministic: boolean;
  /** Session scratch retention settings (AC-20) */
  session: {
    /** Days to retain completed session scratch dirs before purging. */
    retentionDays: number;
    /** When true and the feature run fully completes, archive to _archive/ instead of deleting. */
    archiveOnFeatureArchive: boolean;
  };
  /** Staleness detection for feature context entries (Amendment A AC-46/AC-47) */
  staleness: {
    /** Enable staleness detection. Default: true. */
    enabled: boolean;
    /** Stories after which a context entry is age-stale. Default: 10. */
    maxStoryAge: number;
    /** Score multiplier applied to stale chunks (0–1). Default: 0.4. */
    scoreMultiplier: number;
  };
  /** Built-in provider scope configuration (#507). */
  providers: {
    /** Working directory scope for GitHistoryProvider. Default: "package". */
    historyScope: "repo" | "package";
    /** Working directory scope for CodeNeighborProvider. Default: "package". */
    neighborScope: "repo" | "package";
    /** Cross-package scan depth for CodeNeighborProvider. Default: 1. */
    crossPackageDepth: number;
  };
}

export interface ContextConfig {
  testCoverage: TestCoverageConfig;
  autoDetect: ContextAutoDetectConfig;
  fileInjection?: "keyword" | "disabled";
  featureEngine?: FeatureContextEngineConfig; // Context Engine v1
  /** Context Engine settings (Phase 6: enabled by default) */
  v2: ContextV2Config;
}
