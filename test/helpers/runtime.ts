import { afterEach } from "bun:test";
import type { AgentAdapter, IAgentManager } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";
import { createRuntime, type CreateRuntimeOptions, type NaxRuntime } from "@/runtime";
import type { IReviewAuditor } from "@/runtime";
import type { ISessionManager } from "@/session/types";
import { fakeAgentManager } from "./fake-agent-manager";
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
  /**
   * Factory variant — invoked after the runtime exists, receiving the runtime
   * so the test can construct an agentManager wired to runtime.dispatchEvents.
   * Useful for `fakeAgentManager(adapter, { dispatchEvents: runtime.dispatchEvents })`
   * to faithfully emit session-turn events. Mutually exclusive with `agentManager`.
   */
  agentManagerFactory?: (runtime: NaxRuntime) => IAgentManager;
  sessionManager?: ISessionManager;
  reviewAuditor?: IReviewAuditor;
  config?: NaxConfig;
  workdir?: string;
}

/**
 * Build a runtime + agentManager pair from a mock AgentAdapter, with the fake
 * manager wired to emit `session-turn` dispatch events on the runtime's bus.
 *
 * Use when an integration test exercises `buildPlanForStrategy + plan.run()` (or any callOp
 * path) and asserts on cost/tokenUsage/etc. — those values flow through the
 * dispatch bus in production. Without this wiring, fake events are dropped.
 *
 * ```ts
 * const { runtime, agentManager } = makeRuntimeWithFakeAgent(agent, { config });
 * const callCtx = makeMockCallContext({ runtime });
 * const plan = buildPlanForStrategy(callCtx, story, config, "three-session-tdd", inputs);
 * const result = await plan.run();
 * ```
 */
export function makeRuntimeWithFakeAgent(
  adapter: AgentAdapter,
  opts: Pick<MockRuntimeOptions, "config" | "workdir" | "sessionManager"> = {},
): { runtime: NaxRuntime; agentManager: IAgentManager } {
  const runtime = makeMockRuntime({
    config: opts.config,
    workdir: opts.workdir,
    sessionManager: opts.sessionManager,
    agentManagerFactory: (rt) => fakeAgentManager(adapter, { dispatchEvents: rt.dispatchEvents }),
  });
  return { runtime, agentManager: runtime.agentManager };
}

export function makeMockRuntime(opts: MockRuntimeOptions = {}): NaxRuntime {
  // Default agentManager — used unless factory replaces it after createRuntime.
  const placeholder = opts.agentManager ?? makeMockAgentManager();
  const runtime = trackRuntime(
    createRuntime(opts.config ?? DEFAULT_CONFIG, opts.workdir ?? "/tmp/test", {
      agentManager: placeholder,
      sessionManager: opts.sessionManager ?? makeSessionManager(),
      reviewAuditor: opts.reviewAuditor,
      featureName: "_test",
    }),
  );
  if (opts.agentManagerFactory) {
    // Swap the agentManager in-place — runtime holds a readonly reference but the
    // surrounding mock context (callOp, etc.) reads runtime.agentManager each call.
    Object.defineProperty(runtime, "agentManager", {
      value: opts.agentManagerFactory(runtime),
      writable: false,
      configurable: true,
    });
  }
  return runtime;
}
