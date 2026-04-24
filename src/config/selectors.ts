/**
 * Named ConfigSelector Registry
 *
 * One ConfigSelector per subsystem. This is the single source of truth
 * for "which config slice does each subsystem depend on?"
 *
 * Selectors are used by operations and NaxRuntime to declare config dependencies
 * without duplicating projection logic or creating orphan hardcoded key lists.
 */

import { pickSelector, reshapeSelector } from "./selector";
import type { NaxConfig } from "./types";

/**
 * Review subsystem: review rules, checks, plugins, and debate config
 */
export const reviewConfigSelector = pickSelector("review-config", "review", "debate");

/**
 * Plan subsystem: planning configuration and debate settings
 */
export const planConfigSelector = pickSelector("plan-config", "plan", "debate");

/**
 * Decompose subsystem: decomposer routing and agent config
 */
export const decomposeConfigSelector = pickSelector("decompose-config", "agent");

/**
 * Rectification subsystem: error recovery and retry logic
 */
export const rectifyConfigSelector = pickSelector("rectify-config", "execution");

/**
 * Acceptance subsystem: acceptance test generation and execution
 */
export const acceptanceConfigSelector = pickSelector("acceptance-config", "acceptance", "agent");

/**
 * TDD subsystem: test-driven development orchestration
 */
export const tddConfigSelector = pickSelector("tdd-config", "tdd", "execution", "review");

/**
 * Debate subsystem: multi-agent debate and resolution settings
 */
export const debateConfigSelector = pickSelector("debate-config", "debate", "agent");

/**
 * Routing subsystem: model-tier routing strategies
 */
export const routingConfigSelector = pickSelector("routing-config", "routing", "autoMode", "models", "agent");

/**
 * Verify subsystem: test verification, commands, and timeouts
 * Uses reshapeSelector to compose cross-subsystem fields
 */
export const verifyConfigSelector = reshapeSelector("verify-config", (c: NaxConfig) => ({
  testCommand: c.quality?.commands?.test,
  timeout: c.execution?.verificationTimeoutSeconds,
  smartRunner: c.execution?.smartTestRunner,
  testFilePatterns: c.execution?.smartTestRunner ? c.context?.v2?.pull : undefined,
}));

/**
 * Context subsystem: static rules, file injection, test coverage
 */
export const contextConfigSelector = pickSelector("context-config", "context", "constitution");

/**
 * Quality subsystem: linting, type-checking, autofix
 */
export const qualityConfigSelector = pickSelector("quality-config", "quality", "agent");

/**
 * Execution subsystem: cost limits, timeouts, escalation
 */
export const executionConfigSelector = pickSelector("execution-config", "execution", "autoMode");

/**
 * Cost tracking subsystem: model pricing and token limits
 */
export const costConfigSelector = pickSelector("cost-config", "models", "execution");

/**
 * Hooks subsystem: lifecycle event handlers
 */
export const hooksConfigSelector = pickSelector("hooks-config", "hooks");

/**
 * Agent manager subsystem: agent protocol and fallback routing
 */
export const agentConfigSelector = pickSelector("agent-config", "agent");

/**
 * Interaction subsystem: user interaction config and security triggers
 */
export const interactionConfigSelector = pickSelector("interaction-config", "interaction");

/**
 * Project detection subsystem: language and framework detection
 */
export const projectConfigSelector = pickSelector("project-config", "project");

/**
 * Precheck subsystem: story size and complexity gates
 */
export const precheckConfigSelector = pickSelector("precheck-config", "precheck");

/**
 * Plugins subsystem: plugin registry and disabled list
 */
export const pluginsConfigSelector = pickSelector("plugins-config", "plugins", "disabledPlugins");

/**
 * Optimizer subsystem: prompt optimization strategies
 */
export const optimizerConfigSelector = pickSelector("optimizer-config", "optimizer");

/**
 * Prompts subsystem: prompt customization and overrides
 */
export const promptsConfigSelector = pickSelector("prompts-config", "prompts");

/**
 * Generate subsystem: code generation and discovery options
 */
export const generateConfigSelector = pickSelector("generate-config", "generate");
