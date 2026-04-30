import type { IAgentManager } from "../../src/agents";
import { DEFAULT_CONFIG } from "../../src/config";
import type { NaxConfig } from "../../src/config";
import { createRuntime, type CreateRuntimeOptions, type NaxRuntime } from "../../src/runtime";
import type { IReviewAuditor } from "../../src/runtime";
import type { ISessionManager } from "../../src/session/types";
import { makeMockAgentManager } from "./mock-agent-manager";
import { makeSessionManager } from "./mock-session-manager";

export interface TestRuntimeOptions extends CreateRuntimeOptions {
  config?: NaxConfig;
  workdir?: string;
}

export function makeTestRuntime(opts?: TestRuntimeOptions): NaxRuntime {
  return createRuntime(opts?.config ?? DEFAULT_CONFIG, opts?.workdir ?? "/tmp/test", {
    ...opts,
    featureName: opts?.featureName ?? "_test",
  });
}

/**
 * Build a NaxRuntime suitable for unit tests that exercise the ADR-019 callOp /
 * runWithFallback / openSession+runAsSession dispatch path.
 *
 * Use this when migrating a legacy `agentManager.run()` test to the runtime path:
 * pass the existing agent-manager mock so the runtime's dispatch flows through it.
 *
 * ```ts
 * const agentManager = makeMockAgentManager({
 *   runWithFallbackFn: async (req) => ({ result: { ... }, fallbacks: [], bundle: req.bundle }),
 * });
 * const runtime = makeMockRuntime({ agentManager });
 * await runSemanticReview({ workdir, storyGitRef: ref, story, semanticConfig: cfg, agentManager, runtime });
 * ```
 *
 * - `agentManager` defaults to `makeMockAgentManager()` (no overrides) — supply
 *   one if your test asserts on dispatch behaviour.
 * - `sessionManager` defaults to `makeSessionManager()` — override for tests that
 *   assert on session lifecycle.
 * - `workdir` defaults to `/tmp/test` (no real filesystem access — never used by
 *   the test mocks themselves).
 *
 * Built on top of `createRuntime`, so the resulting object has every NaxRuntime
 * field (`packages`, `costAggregator`, `promptAuditor`, `dispatchEvents`, etc.)
 * with no-op or default-mocked implementations.
 */
export interface MockRuntimeOptions {
  agentManager?: IAgentManager;
  sessionManager?: ISessionManager;
  reviewAuditor?: IReviewAuditor;
  config?: NaxConfig;
  workdir?: string;
}

export function makeMockRuntime(opts: MockRuntimeOptions = {}): NaxRuntime {
  return createRuntime(opts.config ?? DEFAULT_CONFIG, opts.workdir ?? "/tmp/test", {
    agentManager: opts.agentManager ?? makeMockAgentManager(),
    sessionManager: opts.sessionManager ?? makeSessionManager(),
    reviewAuditor: opts.reviewAuditor,
    featureName: "_test",
  });
}
