/**
 * nax#1722 follow-up: `agent.fallback.maxHopsPerStory` is documented — in
 * `src/cli/config-descriptions.ts` and in SPEC-context-engine-agent-fallback — as a
 * per-STORY budget, but `hopsSoFar` was local to a single `runWithFallback` call, so
 * it actually bounded swaps per OPERATION. A story running N ops could take N x cap
 * hops. The budget is now keyed by storyId across every op of a story.
 *
 * A per-story budget alone would strand later ops on a dead primary, because
 * `getDefault()` ignores availability and every op re-probes the primary. So the
 * budget is paired with the dead-primary skip: an op whose primary is already known
 * unavailable starts on the first live fallback instead, consuming no hop.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { AgentManager } from "@/agents";
import { _agentManagerDeps } from "@/agents/manager";
import { buildCompleteEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { CompleteOptions, ResolvedCompleteOptions, SessionHandle, TurnResult } from "@/agents/types";
import { DEFAULT_CONFIG } from "@/config";
import { resolvePermissions } from "@/config/permissions";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure } from "@/context/engine";

const availFailure: AdapterFailure = {
  category: "availability" as const,
  outcome: "fail-auth" as const,
  retriable: false,
  message: "",
};

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
    ...overrides,
  };
}

function configWithFallback(overrides: { maxHopsPerStory?: number; enabled?: boolean } = {}) {
  return makeNaxConfig({
    agent: {
      fallback: {
        enabled: overrides.enabled ?? true,
        map: { claude: ["codex", "gemini"] },
        maxHopsPerStory: overrides.maxHopsPerStory ?? 1,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
  });
}

/**
 * `fail-auth` is sticky for the whole run; `fail-service-down` is cleared by
 * `resetTransientUnavailable()` at a story boundary, which is what a test needs when it
 * wants the next story to start on the primary again rather than on the dead-primary skip.
 */
const transientFailure: AdapterFailure = { ...availFailure, outcome: "fail-service-down" };

/** Hop runner where every named agent succeeds and everything else fails availability. */
function makeRunHop(succeeding: string[], failure: AdapterFailure = availFailure) {
  return async (name: string) => ({
    prompt: `prompt-${name}`,
    result: succeeding.includes(name)
      ? { success: true, exitCode: 0, output: `ok-${name}`, rateLimited: false, durationMs: 1, estimatedCostUsd: 0 }
      : {
          success: false,
          exitCode: 1,
          output: "auth failure",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          adapterFailure: failure,
        },
  });
}

describe("AgentManager — per-story hop budget", () => {
  test("hops spend a budget shared across a story's operations", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"]),
    });

    const first = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-001" }) });
    expect(first.result.success).toBe(true);
    expect(first.fallbacks).toHaveLength(1);

    // Second op of the SAME story: the budget is spent. codex is now the effective
    // primary (dead-primary skip), so the op still runs — but it cannot swap again.
    const second = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-001" }) });
    expect(second.result.success).toBe(true);
    expect(second.fallbacks).toHaveLength(0);
  });

  test("a spent budget stops further swaps within the story", async () => {
    // Nothing succeeds: the first op spends the single hop, the second must not swap.
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, { runHop: makeRunHop([]) });

    const first = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-002" }) });
    expect(first.fallbacks).toHaveLength(1);

    const second = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-002" }) });
    expect(second.fallbacks).toHaveLength(0);
  });

  test("a different story gets its own budget", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"], transientFailure),
    });

    await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-003" }) });
    // Story boundary: the transient unavailability clears, so us-004 starts on the
    // primary again and its own budget lets it swap.
    m.resetTransientUnavailable();

    const other = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-004" }) });
    expect(other.fallbacks).toHaveLength(1);
  });

  test("calls with no storyId keep a per-call budget", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"], transientFailure),
    });

    const first = await m.runWithFallback({ runOptions: makeRunOptions() });
    expect(first.fallbacks).toHaveLength(1);
    m.resetTransientUnavailable();

    const second = await m.runWithFallback({ runOptions: makeRunOptions() });
    expect(second.fallbacks).toHaveLength(1);
  });

  test("reset() clears the budget", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 1 }), undefined, {
      runHop: makeRunHop(["codex"]),
    });

    await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-005" }) });
    m.reset();

    const after = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-005" }) });
    expect(after.fallbacks).toHaveLength(1);
  });
});

describe("AgentManager — dead-primary skip", () => {
  test("an op whose primary is already unavailable starts on the fallback, spending no hop", async () => {
    const m = new AgentManager(configWithFallback(), undefined, { runHop: makeRunHop(["codex"]) });
    m.markUnavailable("claude", availFailure);

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-006" }) });

    expect(outcome.result.output).toBe("ok-codex");
    expect(outcome.fallbacks).toHaveLength(0);
    expect(outcome.finalAgent).toBe("codex");
  });

  test("the chain still walks from the configured primary after a skip", async () => {
    // codex is dead too — the swap from the substituted start must find gemini,
    // which only map["claude"] lists.
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 2 }), undefined, {
      runHop: makeRunHop(["gemini"]),
    });
    m.markUnavailable("claude", availFailure);

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-007" }) });

    expect(outcome.result.output).toBe("ok-gemini");
    expect(outcome.finalAgent).toBe("gemini");
    expect(outcome.fallbacks).toHaveLength(1);
  });

  test("no skip when fallback is disabled", async () => {
    const m = new AgentManager(configWithFallback({ enabled: false }), undefined, { runHop: makeRunHop(["codex"]) });
    m.markUnavailable("claude", availFailure);

    const outcome = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-008" }) });

    expect(outcome.result.success).toBe(false);
    expect(outcome.finalAgent).toBe("claude");
  });

  // nax#1966 fix-round-1: a bad instruction had the primary hop's swap-branch
  // markUnavailable default its tier to `runOptions.modelTier` instead of staying
  // tier-less. `fail-rate-limit` is `cooldownScope: "model"` (retry/failure-policy.ts),
  // so that write landed on `claude::balanced` instead of the bare `claude` key —
  // exactly the key `resolveStartAgent`'s tier-less `isUnavailable(primary)` probe
  // reads (hop-budget.ts) to skip a known-dead primary on a story's later ops. Unlike
  // the tests above, this drives the skip through a REAL failed `runWithFallback` hop
  // (not a direct `markUnavailable` call) with a model-scoped outcome, so it is the
  // only test in this suite that would have caught that regression.
  test("a real fail-rate-limit hop still triggers the dead-primary skip on the next op", async () => {
    const rateLimitFailure: AdapterFailure = {
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "rate limited",
    };
    const calls: string[] = [];
    const hop = makeRunHop(["codex"], rateLimitFailure);
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 2 }), undefined, {
      runHop: async (name) => {
        calls.push(name);
        return hop(name);
      },
    });

    const first = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-009" }) });
    expect(first.result.success).toBe(true);
    expect(first.fallbacks).toHaveLength(1);

    calls.length = 0;
    const second = await m.runWithFallback({ runOptions: makeRunOptions({ storyId: "us-009" }) });

    // The primary ("claude") must not be re-probed: the second op starts directly on
    // the fallback and spends no hop.
    expect(calls).toEqual(["codex"]);
    expect(second.fallbacks).toHaveLength(0);
    expect(second.finalAgent).toBe("codex");
  });
});

/**
 * nax#1965 fix-round-2: the dead-primary skip must key on the ENDPOINT an operation
 * would actually dispatch to, not the bare agent name — one role's rate-limit must
 * not divert every other role off its own configured tier/model of the same agent
 * (native transport: one agent fronts several providers). But a genuinely
 * agent-wide fault (bad credentials, missing binary) must still stop every
 * endpoint of that agent. Both directions are asserted here, driven through real
 * failed `runWithFallback` hops (not direct `markUnavailable` calls), the same way
 * the #1970 regression test above does.
 */
describe("AgentManager — dead-primary skip is scoped to the dispatched endpoint", () => {
  const rateLimitFailure: AdapterFailure = {
    category: "availability",
    outcome: "fail-rate-limit",
    retriable: true,
    message: "rate limited",
  };

  test("a rate-limit recorded against one endpoint does not block a different endpoint of the same agent", async () => {
    const calls: string[] = [];
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 2 }), undefined, {
      runHop: async (name: string, options: AgentRunOptions) => {
        calls.push(`${name}:${options.modelTier}`);
        if (name === "claude" && options.modelTier === "balanced") {
          return {
            prompt: `prompt-${name}`,
            result: {
              success: false,
              exitCode: 1,
              output: "rate limited",
              rateLimited: true,
              durationMs: 1,
              estimatedCostUsd: 0,
              adapterFailure: rateLimitFailure,
            },
          };
        }
        return {
          prompt: `prompt-${name}`,
          result: {
            success: true,
            exitCode: 0,
            output: `ok-${name}`,
            rateLimited: false,
            durationMs: 1,
            estimatedCostUsd: 0,
          },
        };
      },
    });

    // First op dispatches "claude" at "balanced" and rate-limits, marking the
    // cooldown against THAT endpoint, then swaps to codex.
    const balancedOutcome = await m.runWithFallback({
      runOptions: makeRunOptions({
        storyId: "us-010a",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      }),
    });
    expect(balancedOutcome.result.success).toBe(true);
    expect(balancedOutcome.finalAgent).toBe("codex");

    // Second op — a different story (fresh hop budget) dispatching a DIFFERENT
    // tier/model of the SAME agent — must still start on "claude": that endpoint
    // was never marked, so the narrow, endpoint-aware probe must miss.
    calls.length = 0;
    const powerfulOutcome = await m.runWithFallback({
      runOptions: makeRunOptions({
        storyId: "us-010b",
        modelTier: "powerful",
        modelDef: { provider: "anthropic", model: "claude-opus-4-1" },
      }),
    });
    expect(calls).toEqual(["claude:powerful"]);
    expect(powerfulOutcome.result.success).toBe(true);
    expect(powerfulOutcome.finalAgent).toBe("claude");
  });

  test("a genuinely agent-scoped failure (fail-auth) still blankets every endpoint of that agent", async () => {
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 2 }), undefined, {
      runHop: makeRunHop(["codex"], availFailure),
    });
    // Sticky, run-long fault — bad credentials, not tied to any one tier or model.
    m.markUnavailable("claude", availFailure);

    // Dispatching at a DIFFERENT tier/model than any prior op must still be
    // diverted: an agent-wide fault blankets every endpoint of "claude".
    const outcome = await m.runWithFallback({
      runOptions: makeRunOptions({
        storyId: "us-012",
        modelTier: "powerful",
        modelDef: { provider: "anthropic", model: "claude-opus-4-1" },
      }),
    });

    expect(outcome.result.output).toBe("ok-codex");
    expect(outcome.fallbacks).toHaveLength(0);
    expect(outcome.finalAgent).toBe("codex");
  });

  // nax#1965 fix-round-2: `executeHop`'s default-from-`options.modelDef` fix only
  // applies to a PRIMARY hop. `currentRunOptions` is never rebuilt across a swap in
  // `runWithFallback` (only a timeout-retry reassigns it), so after a swap the SAME
  // stale `options.modelDef` (the ORIGINAL primary's) would still be in scope for the
  // swapped-to agent's hop. Defaulting there would record the swapped-to agent's
  // failure under the primary's model identity — cooling an endpoint that is alive
  // (the primary's own) while leaving the actually-dead one (the swapped-to agent's
  // real endpoint) unrecorded. This pins that a swap-kind hop's failure is NOT
  // recorded under the stale primary identity.
  test("a swapped hop through the runHop seam is not recorded under the stale primary model identity", async () => {
    const rateLimitFailure: AdapterFailure = {
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "rate limited",
    };
    // claude (primary) and codex (first swap target) both rate-limit; gemini
    // (second swap target) succeeds, so the chain terminates on success — no
    // hop-cap exhaustion, so no real `defaultRetryStrategy` backoff sleep.
    const m = new AgentManager(configWithFallback({ maxHopsPerStory: 2 }), undefined, {
      runHop: async (name: string) => {
        if (name === "gemini") {
          return {
            prompt: `prompt-${name}`,
            result: {
              success: true,
              exitCode: 0,
              output: "ok-gemini",
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
            },
          };
        }
        return {
          prompt: `prompt-${name}`,
          result: {
            success: false,
            exitCode: 1,
            output: "rate limited",
            rateLimited: true,
            durationMs: 1,
            estimatedCostUsd: 0,
            adapterFailure: rateLimitFailure,
          },
        };
      },
    });

    await m.runWithFallback({
      runOptions: makeRunOptions({
        storyId: "us-013",
        modelTier: "balanced",
        modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
      }),
    });

    // The primary hop's own failure IS recorded against its real dispatch identity
    // (defaulted from options.modelDef, since this is a "primary" hop).
    expect(m.isUnavailable("claude", "balanced", "claude-sonnet-4-5")).toBe(true);

    // The swapped-to agent's hop failed too, through a "swap"-kind HopKind — it must
    // NOT inherit the stale primary's modelDef default. If it had, codex would show
    // unavailable under claude's own model id, which is the wrong identity for it.
    expect(m.isUnavailable("codex", "balanced", "claude-sonnet-4-5")).toBe(false);
  });
});

// ─── US-002/US-004: dispatch-event builders (sessionId, pricingSource) ───────

const PERMS = resolvePermissions(DEFAULT_CONFIG, "complete");

function makeOptions(): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    workdir: "/tmp",
    resolvedPermissions: PERMS,
  };
}

describe("buildCompleteEvent — sessionId plumbing", () => {
  test("US-002 AC4: sessionId supplied on options reaches the returned event", () => {
    // AC 4 calls buildCompleteEvent's `input.sessionId` — the story describes
    // it as a plain field on the dispatcher event, so we exercise the build
    // path that would surface an adapter-supplied id.
    const startedAt = 1_000;
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      startedAt,
      sessionId: "nax-abc12345",
    });

    expect(event.kind).toBe("complete");
    expect(event.sessionId).toBe("nax-abc12345");
  });

  test("US-002 AC5: no sessionId on input means the returned event has no sessionId property", () => {
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      startedAt: 1_000,
    });

    expect(event.kind).toBe("complete");
    // The exact invariant the AC names: no sessionId property at all.
    expect("sessionId" in event).toBe(false);
  });
});

// US-004: the dispatch-event builders forward the producer-supplied
// pricingSource from the adapter's result so the cost subscriber can prefer
// it over the model-derived default.
describe("buildSessionTurnEvent — pricingSource plumbing (US-004)", () => {
  test("US-004 AC7: TurnResult.pricingSource catalog-rates reaches the returned event", () => {
    const handle: SessionHandle = {
      id: "nax-test-handle",
      agentName: "native",
      modelDef: { provider: "openai", model: "gpt-5.6-terra" },
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      exactCostUsd: 0.001,
      internalRoundTrips: 1,
      pricingSource: "catalog-rates",
    };
    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "native",
      stage: "run",
      opts: { pipelineStage: "run", storyId: "US-004" },
      resolvedPermissions: PERMS,
      startedAt: 1_000,
    });

    expect(event.kind).toBe("session-turn");
    expect(event.pricingSource).toBe("catalog-rates");
  });

  test("TurnResult without pricingSource means the returned event has no pricingSource property", () => {
    // The exact invariant the AC names for the no-value case: omitted (not
    // undefined) so the cost subscriber's "in" check distinguishes "no report"
    // from "explicitly unknown".
    const handle: SessionHandle = {
      id: "nax-test-handle",
      agentName: "claude",
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      internalRoundTrips: 1,
    };
    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "claude",
      stage: "run",
      opts: { pipelineStage: "run" },
      resolvedPermissions: PERMS,
      startedAt: 1_000,
    });

    expect(event.kind).toBe("session-turn");
    expect("pricingSource" in event).toBe(false);
  });
});

describe("buildCompleteEvent — pricingSource plumbing (US-004)", () => {
  test("buildCompleteEvent forwards pricingSource from the producer result", () => {
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      exactCostUsd: 0.001,
      startedAt: 1_000,
      // The producer-supplied rate card lives on CompleteResult / TurnResult
      // (US-003); US-004 forwards it onto the dispatch event via the builder.
      // We simulate that by passing the value through buildCompleteEvent's
      // pricingSource input.
      pricingSource: "catalog-rates",
    });

    expect(event.kind).toBe("complete");
    expect(event.pricingSource).toBe("catalog-rates");
  });
});

// ─── #585: AbortSignal plumbing through runWithFallback backoff ──────────────

const rateLimitFailure = {
  category: "availability" as const,
  outcome: "fail-rate-limit" as const,
  retriable: true,
  message: "429",
};

const mockBundle = {} as import("@/context/engine").ContextBundle;

function makeConfigNoFallback() {
  // No fallback chain — forces the rate-limit-backoff branch rather than a swap.
  return makeNaxConfig({
    agent: {
      fallback: { enabled: false, map: {}, maxHopsPerStory: 0, onQualityFailure: false, rebuildContext: false },
    },
  });
}

function abortMakeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
    ...overrides,
  };
}

function makeRateLimitedRunHop() {
  return async () => ({
    prompt: "prompt-mock",
    result: {
      success: false,
      exitCode: 1,
      output: "rate limit",
      rateLimited: true,
      durationMs: 1,
      estimatedCostUsd: 0,
      adapterFailure: rateLimitFailure,
    },
  });
}

describe("AgentManager.runWithFallback — abort signal (#585)", () => {
  const origSleep = _agentManagerDeps.sleep;
  afterEach(() => {
    _agentManagerDeps.sleep = origSleep;
  });

  test("pre-aborted signal stops backoff immediately (no sleep issued)", async () => {
    const sleepCalls: Array<{ ms: number; aborted: boolean }> = [];
    _agentManagerDeps.sleep = async (ms, signal) => {
      sleepCalls.push({ ms, aborted: Boolean(signal?.aborted) });
    };

    const controller = new AbortController();
    controller.abort();

    const m = new AgentManager(makeConfigNoFallback(), undefined, { runHop: makeRateLimitedRunHop() });
    const outcome = await m.runWithFallback({
      runOptions: abortMakeRunOptions({ storyId: "s1" }),
      bundle: mockBundle,
      signal: controller.signal,
    });

    // The adapter ran once and returned the rate-limit failure.
    // Backoff sleep must NOT have been issued because the signal was already aborted.
    expect(outcome.result.success).toBe(false);
    expect(sleepCalls).toHaveLength(0);
  });

  test("signal forwarded to sleep — backoff races against it", async () => {
    let receivedSignal: AbortSignal | undefined;
    _agentManagerDeps.sleep = async (_ms, signal) => {
      receivedSignal = signal;
    };

    const controller = new AbortController();
    const m = new AgentManager(makeConfigNoFallback(), undefined, { runHop: makeRateLimitedRunHop() });
    await m.runWithFallback({
      runOptions: abortMakeRunOptions({ storyId: "s1" }),
      bundle: mockBundle,
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("abort during backoff returns without further retries", async () => {
    const controller = new AbortController();
    // Simulate a sleep that "wakes up" to find the signal aborted.
    _agentManagerDeps.sleep = async (_ms, signal) => {
      if (signal && !signal.aborted) {
        // abort the signal while the backoff sleep is in flight
        controller.abort();
      }
    };

    // Abort after a microtask so the first hop runs, then the signal is aborted
    // before the backoff loop checks again.
    queueMicrotask(() => controller.abort());

    const m = new AgentManager(makeConfigNoFallback(), undefined, { runHop: makeRateLimitedRunHop() });
    const startHops = performance.now();
    const outcome = await m.runWithFallback({
      runOptions: abortMakeRunOptions({ storyId: "s1" }),
      bundle: mockBundle,
      signal: controller.signal,
    });
    const elapsed = performance.now() - startHops;

    // Settled quickly, did not loop through all 3 backoff attempts.
    expect(elapsed).toBeLessThan(500);
    expect(outcome.result.adapterFailure?.outcome).toBe("fail-rate-limit");
  });
});
