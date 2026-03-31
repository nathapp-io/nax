/**
 * Default Configuration
 *
 * The default NaxConfig used as a base for all projects.
 */

import type { DebateConfig } from "../debate/types";
import type { NaxConfig } from "./types";

/** Default configuration */
export const DEFAULT_CONFIG: NaxConfig = {
  version: 1,
  models: {
    claude: {
      fast: "haiku",
      balanced: "sonnet",
      powerful: "opus",
    },
  },
  autoMode: {
    enabled: true,
    defaultAgent: "claude",
    fallbackOrder: ["claude"], // single-agent fallback chain
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
    llm: {
      model: "fast",
      fallbackToKeywords: true,
      cacheDecisions: true,
      mode: "hybrid",
      timeoutMs: 30000,
    },
  },
  execution: {
    maxIterations: 10, // auto-calculated: sum of tier attempts (5+3+2=10)
    iterationDelayMs: 2000,
    costLimit: 30.0,
    sessionTimeoutSeconds: 3600, // 1 hour
    verificationTimeoutSeconds: 600, // 10 minutes
    maxStoriesPerFeature: 500,
    rectification: {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 300,
      maxFailureSummaryChars: 2000,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
      rethinkAtAttempt: 2,
      urgencyAtAttempt: 3,
    },
    regressionGate: {
      enabled: true,
      timeoutSeconds: 300,
      acceptOnTimeout: true,
      maxRectificationAttempts: 2,
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
    stripEnvVars: [
      // Agent detection markers
      "CLAUDECODE",
      "REPL_ID",
      "AGENT",
      // Source control tokens
      "GITLAB_ACCESS_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ACCESS_TOKEN",
      "GH_TOKEN",
      "CI_GIT_TOKEN",
      "CI_JOB_TOKEN",
      "BITBUCKET_ACCESS_TOKEN",
      // Package registry tokens
      "NPM_TOKEN",
      "NPM_AUTH_TOKEN",
      "YARN_NPM_AUTH_TOKEN",
      // LLM API keys (agent gets these via allowlist in buildAllowedEnv; test runners don't need them)
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "COHERE_API_KEY",
      // Cloud / infra credentials
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GCLOUD_SERVICE_KEY",
      "AZURE_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      // CI secrets
      "TELEGRAM_BOT_TOKEN",
      "SLACK_TOKEN",
      "SLACK_WEBHOOK_URL",
      "SENTRY_AUTH_TOKEN",
      "DATADOG_API_KEY",
    ],
    testing: {
      hermetic: true,
    },
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
    checks: ["typecheck", "lint"],
    commands: {},
    pluginMode: "per-story",
    semantic: {
      modelTier: "balanced",
      rules: [],
      timeoutMs: 600_000,
      excludePatterns: [":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/"],
    },
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
    model: "fast" as const,
    refinement: true,
    redGate: true,
    timeoutMs: 1800000,
  },
  context: {
    fileInjection: "disabled",
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
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      action: "block" as const,
      maxReplanAttempts: 3,
    },
  },
  prompts: {},
  agent: {
    protocol: "acp",
  },
  debate: {
    enabled: false,
    agents: 3,
    stages: {
      plan: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "stateful",
        rounds: 3,
      },
      review: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 2,
      },
      acceptance: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      rectification: {
        enabled: false,
        resolver: { type: "synthesis" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      escalation: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    },
  } satisfies DebateConfig,
};
