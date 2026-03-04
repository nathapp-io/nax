/**
 * Default Configuration
 *
 * The default NaxConfig used as a base for all projects.
 */

import type { NaxConfig } from "./types";

/** Default configuration */
export const DEFAULT_CONFIG: NaxConfig = {
  version: 1,
  models: {
    fast: { provider: "anthropic", model: "haiku" },
    balanced: { provider: "anthropic", model: "sonnet" },
    powerful: { provider: "anthropic", model: "opus" },
  },
  autoMode: {
    enabled: true,
    defaultAgent: "claude",
    fallbackOrder: ["claude", "codex", "opencode", "gemini"],
    complexityRouting: {
      simple: "fast",
      medium: "balanced",
      complex: "powerful",
      expert: "powerful",
    },
    escalation: {
      enabled: true,
      tierOrder: [
        { tier: "fast", attempts: 5 },
        { tier: "balanced", attempts: 3 },
        { tier: "powerful", attempts: 2 },
      ],
      escalateEntireBatch: true,
    },
  },
  routing: {
    strategy: "keyword",
    adaptive: {
      minSamples: 10,
      costThreshold: 0.8,
      fallbackStrategy: "llm",
    },
    llm: {
      model: "fast",
      fallbackToKeywords: true,
      cacheDecisions: true,
      mode: "hybrid",
      timeoutMs: 15000,
    },
  },
  execution: {
    maxIterations: 10, // auto-calculated: sum of tier attempts (5+3+2=10)
    iterationDelayMs: 2000,
    costLimit: 5.0,
    sessionTimeoutSeconds: 600, // 10 minutes
    verificationTimeoutSeconds: 300, // 5 minutes
    maxStoriesPerFeature: 500,
    rectification: {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 120,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
    },
    regressionGate: {
      enabled: true,
      timeoutSeconds: 120,
      acceptOnTimeout: true,
    },
    contextProviderTokenBudget: 2000,
    smartTestRunner: true,
  },
  quality: {
    requireTypecheck: true,
    requireLint: true,
    requireTests: true,
    commands: {},
    forceExit: false,
    detectOpenHandles: true,
    detectOpenHandlesRetries: 1,
    gracePeriodMs: 5000,
    drainTimeoutMs: 2000,
    shell: "/bin/sh",
    stripEnvVars: ["CLAUDECODE", "REPL_ID", "AGENT"],
    environmentalEscalationDivisor: 2,
  },
  tdd: {
    maxRetries: 2,
    autoVerifyIsolation: true,
    autoApproveVerifier: true,
    strategy: "auto",
    sessionTiers: {
      testWriter: "balanced",
      // implementer: undefined = uses story's routed tier
      verifier: "fast",
    },
    testWriterAllowedPaths: ["src/index.ts", "src/**/index.ts"],
    rollbackOnFailure: true,
    greenfieldDetection: true,
  },
  constitution: {
    enabled: true,
    path: "constitution.md",
    maxTokens: 2000,
  },
  analyze: {
    llmEnhanced: true,
    model: "balanced",
    fallbackToKeywords: true,
    maxCodebaseSummaryTokens: 5000,
  },
  review: {
    enabled: true,
    checks: ["typecheck", "lint", "test"],
    commands: {},
  },
  plan: {
    model: "balanced",
    outputPath: "spec.md",
  },
  acceptance: {
    enabled: true,
    maxRetries: 2,
    generateTests: true,
    testPath: "acceptance.test.ts",
  },
  context: {
    testCoverage: {
      enabled: true,
      detail: "names-and-counts",
      maxTokens: 500,
      testPattern: "**/*.test.{ts,js,tsx,jsx}",
      scopeToStory: true,
    },
    autoDetect: {
      enabled: true,
      maxFiles: 5,
      traceImports: false,
    },
  },
  interaction: {
    plugin: "cli",
    config: {},
    defaults: {
      timeout: 600000, // 10 minutes
      fallback: "escalate",
    },
    triggers: {
      "security-review": true,
      "cost-warning": true,
    },
  },
  precheck: {
    storySizeGate: {
      enabled: true,
      maxAcCount: 6,
      maxDescriptionLength: 2000,
      maxBulletPoints: 8,
    },
  },
};
