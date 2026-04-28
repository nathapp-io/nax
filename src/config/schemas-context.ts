/**
 * Context engine schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";

const TestCoverageConfigSchema = z.object({
  enabled: z.boolean().default(true),
  detail: z.enum(["names-only", "names-and-counts", "describe-blocks"]).default("names-and-counts"),
  maxTokens: z.number().int().min(50).max(5000).default(500),
  testDir: z.string().optional(),
  /** @deprecated Migrate to execution.smartTestRunner.testFilePatterns. Migration shim in src/config/migrations.ts. */
  testPattern: z.string().optional(),
  scopeToStory: z.boolean().default(true),
});

const ContextAutoDetectConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(20).default(5),
  traceImports: z.boolean().default(false),
});

const FeatureContextEngineConfigSchema = z.object({
  enabled: z.boolean().default(false),
  budgetTokens: z.number().int().min(256).default(2048),
});

// Context Engine v2 pull tool config (Phase 4)
const ContextV2PullConfigSchema = z
  .object({
    /**
     * Enable pull tools for this run.
     * When false (default), assemble() returns an empty pullTools array.
     */
    enabled: z.boolean().default(false),
    /**
     * Tool names permitted to activate. Empty array = all stage-configured tools allowed.
     * Use to restrict which tools are enabled without changing the stage map.
     */
    allowedTools: z.array(z.string()).default([]),
    /**
     * Per-session call ceiling (overrides the descriptor default when set).
     */
    maxCallsPerSession: z.number().int().min(0).default(5),
    /**
     * Per-run call ceiling across all sessions in a single nax run.
     */
    maxCallsPerRun: z.number().int().min(0).default(50),
  })
  .default(() => ({ enabled: false, allowedTools: [], maxCallsPerSession: 5, maxCallsPerRun: 50 }));

// Context Engine v2 rules config (Phase 5.1)
const ContextV2RulesConfigSchema = z
  .object({
    /**
     * Fall back to reading CLAUDE.md + .claude/rules/ when .nax/rules/ is absent.
     * Default false — legacy fallback must be explicitly opted in.
     * Set true only during migration to the canonical .nax/rules/ store.
     */
    allowLegacyClaudeMd: z.boolean().default(false),
    /**
     * Token ceiling for canonical rules. Lower-priority rules are tail-truncated
     * when this budget is exceeded.
     */
    budgetTokens: z.number().int().min(512).default(8192),
  })
  .default(() => ({ allowLegacyClaudeMd: false, budgetTokens: 8192 }));

// Context Engine plugin provider config (Phase 7)
const ContextPluginProviderConfigSchema = z.object({
  /**
   * Module specifier for the plugin provider.
   * Accepts npm package names (e.g. "@company/nax-rag") or paths
   * relative to the project workdir (e.g. "./plugins/my-provider.js").
   */
  module: z.string().min(1),
  /**
   * Provider-specific config object passed to provider.init(config) on load.
   * Shape is provider-defined — the engine passes it through opaquely.
   */
  config: z.record(z.string(), z.unknown()).optional(),
  /**
   * Set false to skip this provider without removing the config entry.
   * Useful for temporarily disabling a provider for debugging.
   */
  enabled: z.boolean().default(true),
});

const ContextV2StageOverrideSchema = z.object({
  budgetTokens: z.number().int().positive().optional(),
  extraProviderIds: z.array(z.string().min(1)).default([]),
});

// Context Engine config (Phase 6: selective on; operators opt in per project)
export const ContextV2ConfigSchema = z
  .object({
    /**
     * Enable Context Engine orchestrator.
     * Default: false — operators opt in by setting this true in their project config.
     * Phase 6: selective on; Phase 7: plugin providers available once enabled.
     */
    enabled: z.boolean().default(false),
    /**
     * Minimum score threshold — chunks below this are dropped as noise.
     * Phase 0: near-zero (0.1) so existing content is almost never filtered.
     * Post-GA: tuned upward once effectiveness signal data is available.
     */
    minScore: z.number().min(0).max(1).default(0.1),
    /** Pull tool configuration (Phase 4+) */
    pull: ContextV2PullConfigSchema,
    /** Canonical rules store configuration (Phase 5.1+) */
    rules: ContextV2RulesConfigSchema,
    /**
     * External plugin provider registrations (Phase 7+).
     * Each entry loads a module that exports an IContextProvider-compatible object.
     * Empty by default — operators add providers for RAG, graph, or KB use cases.
     */
    pluginProviders: z.array(ContextPluginProviderConfigSchema).default([]),
    /**
     * Per-stage token budget overrides (AC-59).
     * Keys are pipeline stage names (e.g. "execution", "tdd-implementer").
     * Set in per-package config (<repoRoot>/.nax/mono/<packageDir>/config.json)
     * to override the default stage budget for a specific package.
     *
     * Example: { "execution": { "budgetTokens": 15000 } }
     */
    stages: z.record(z.string().min(1), ContextV2StageOverrideSchema).default({}),
    /**
     * Determinism mode (AC-24).
     * When true, providers that declare `deterministic: false` are excluded from assembly.
     * Guarantees two runs with identical inputs produce identical push blocks.
     * Default: false — all providers run regardless of determinism declaration.
     */
    deterministic: z.boolean().default(false),
    /**
     * Session scratch retention settings (AC-20).
     * Controls how long completed session scratch dirs are kept on disk.
     */
    session: z
      .object({
        /** Days to keep completed session scratch dirs before purging. Default: 7. */
        retentionDays: z.number().int().min(1).default(7),
        /** When true and the feature run completes fully, archive scratch to _archive/ instead of deleting. Default: true. */
        archiveOnFeatureArchive: z.boolean().default(true),
      })
      .default(() => ({ retentionDays: 7, archiveOnFeatureArchive: true })),
    /**
     * Built-in provider scope configuration (#507).
     * Controls which working directory each built-in provider uses when
     * executing git/glob queries in monorepo setups.
     */
    providers: z
      .object({
        /**
         * Working directory scope for GitHistoryProvider (#507).
         * "package" — run git log in packageDir (monorepo-safe default).
         * "repo" — run git log in repoRoot (full repo history).
         */
        historyScope: z.enum(["repo", "package"]).default("package"),
        /**
         * Working directory scope for CodeNeighborProvider (#507).
         * "package" — scan neighbours within packageDir (monorepo-safe default).
         * "repo" — scan neighbours in repoRoot.
         */
        neighborScope: z.enum(["repo", "package"]).default("package"),
        /**
         * Cross-package scan depth for CodeNeighborProvider in monorepo mode (#507).
         * 0 disables cross-package scanning. Default: 1 (one package level up).
         * Only active when neighborScope is "package" and the story has a workdir.
         */
        crossPackageDepth: z.number().int().min(0).default(1),
      })
      .default({ historyScope: "package", neighborScope: "package", crossPackageDepth: 1 }),
    /**
     * Staleness detection for feature context entries (Amendment A AC-46/AC-47).
     * Downweights old or contradicted entries in context.md so stale advice
     * does not crowd out fresh context. No chunks are auto-removed — humans
     * must edit context.md to remove stale entries.
     */
    staleness: z
      .object({
        /** Enable staleness detection. Default: true. */
        enabled: z.boolean().default(true),
        /**
         * Number of completed stories after which a context entry is considered
         * age-stale. Measured by position in context.md (entries are appended
         * in story order). Default: 10.
         */
        maxStoryAge: z.number().int().min(1).default(10),
        /**
         * Score multiplier applied to stale chunks (0–1).
         * 0.4 = stale entry scores 40% of its normal weight, making it less
         * likely to beat fresh context for the same budget slot.
         */
        scoreMultiplier: z.number().min(0).max(1).default(0.4),
      })
      .default(() => ({ enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 })),
  })
  .default(() => ({
    enabled: false,
    minScore: 0.1,
    pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5, maxCallsPerRun: 50 },
    rules: { allowLegacyClaudeMd: false, budgetTokens: 8192 },
    pluginProviders: [],
    stages: {},
    deterministic: false,
    session: { retentionDays: 7, archiveOnFeatureArchive: true },
    staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 },
    providers: { historyScope: "package" as const, neighborScope: "package" as const, crossPackageDepth: 1 },
  }));

export const ContextConfigSchema = z.object({
  testCoverage: TestCoverageConfigSchema,
  autoDetect: ContextAutoDetectConfigSchema,
  fileInjection: z.enum(["keyword", "disabled"]).default("disabled"),
  featureEngine: FeatureContextEngineConfigSchema.optional(),
  /** Context Engine settings (Phase 6: enabled by default) */
  v2: ContextV2ConfigSchema,
});
