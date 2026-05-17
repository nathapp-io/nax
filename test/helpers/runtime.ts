import { afterEach } from "bun:test";
import type { IAgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";
import { createRuntime, type CreateRuntimeOptions, type NaxRuntime } from "@/runtime";
import type { IReviewAuditor } from "@/runtime";
import type { ISessionManager } from "@/session/types";
import { makeMockAgentManager } from "./mock-agent-manager";
import { makeSessionManager } from "./mock-session-manager";

const createdRuntimes = new Set<NaxRuntime>();

async function closeCreatedRuntimes(): Promise<void> {
  const runtimes = Array.from(createdRuntimes);
  createdRuntimes.clear();
  await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
}

// Registered once at module load time — fires in the scope of the first test
// file that imports this module. Additional registrations inside trackRuntime
// ensure the hook fires in every subsequent test file's scope as well.
afterEach(closeCreatedRuntimes);

function trackRuntime(runtime: NaxRuntime): NaxRuntime {
  createdRuntimes.add(runtime);

  // Register cleanup in the current test file's scope. If the module-level
  // afterEach already fired (createdRuntimes is empty), this is a no-op.
  afterEach(closeCreatedRuntimes);

  const close = runtime.close.bind(runtime);
  runtime.close = async () => {
    createdRuntimes.delete(runtime);
    await close();
  };

  return runtime;
}

export interface TestRuntimeOptions extends CreateRuntimeOptions {
  config?: NaxConfig;
  workdir?: string;
}

export function makeTestRuntime(opts?: TestRuntimeOptions): NaxRuntime {
  return trackRuntime(createRuntime(opts?.config ?? DEFAULT_CONFIG, opts?.workdir ?? "/tmp/test", {
    ...opts,
    featureName: opts?.featureName ?? "_test",
  }));
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
  return trackRuntime(createRuntime(opts.config ?? DEFAULT_CONFIG, opts.workdir ?? "/tmp/test", {
    agentManager: opts.agentManager ?? makeMockAgentManager(),
    sessionManager: opts.sessionManager ?? makeSessionManager(),
    reviewAuditor: opts.reviewAuditor,
    featureName: "_test",
  }));
}
