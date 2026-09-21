/**
 * Root collapse (single-frame redesign PR2, Task 1).
 *
 * PR1 decoupled a declared command's cwd (`RunCommandToolOptions.commandCwd`)
 * from the agent's containment root. This is the collapse itself: the native
 * `codingToolRoot` and the ACP spawn cwd (`workdir`) both move from the story's
 * PACKAGE dir to `storyExecRoot(ctx.packageView)`.
 *
 * For a non-worktree package those differ (`/repo` vs `/repo/packages/api`); for
 * a worktree-isolated story the exec root is the worktree root, so the agent is
 * contained inside the story's own tree and cannot escape to the main checkout
 * (nax#2093, spec Risk-table R2).
 *
 * Anchored on the dispatch seam (`runWithFallback`/`completeAs`), not on the
 * `buildRunDispatchOptions` literal alone, so a future divergence between the
 * builder and what callOp actually sends is caught.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import type { AgentRunOptions, CompleteOptions } from "@/agents/types";
import { type DEFAULT_CONFIG, type NaxConfig, pickSelector } from "@/config";
import { createRunCallCounter } from "@/context/engine";
import type { BuildHopCallbackContext, CallContext, CompleteOperation, RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { packageWorkdir, storyExecRoot } from "@/runtime/packages";

const testSel = pickSelector("call-root-collapse-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const successResult = {
  success: true,
  exitCode: 0,
  output: "ok",
  rateLimited: false,
  durationMs: 1,
  estimatedCostUsd: 0,
  agentFallbacks: [],
};

function makeRunOp(): RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name: "root-collapse-run",
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You echo text.", overridable: false },
      task: { id: "task", content: input.text, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

function makeCompleteOp(): CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "complete",
    name: "root-collapse-complete",
    stage: "run",
    config: testSel,
    build: (input) => ({
      role: { id: "role", content: "You echo text.", overridable: false },
      task: { id: "task", content: input.text, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

describe("callOp root collapse — package story", () => {
  test("runOptions.codingToolRoot and workdir are storyExecRoot, not the package workdir", async () => {
    let seen: AgentRunOptions | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        seen = req.runOptions;
        return { result: successResult, fallbacks: [], dispatchesCompleted: 1 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager(), workdir: "/repo" });
    createdRuntimes.push(runtime);
    const packageView = runtime.packages.resolve("packages/api");
    // Sanity: the two candidate roots genuinely differ for a package story.
    expect(storyExecRoot(packageView)).toBe("/repo");
    expect(packageWorkdir(packageView)).toBe("/repo/packages/api");

    await callOp(
      { runtime, packageView, packageDir: "packages/api", agentName: "claude", storyId: "US-001" },
      makeRunOp(),
      { text: "hi" },
    );

    expect(seen?.codingToolRoot).toBe(storyExecRoot(packageView));
    expect(seen?.codingToolRoot).toBe("/repo");
    expect(seen?.codingToolRoot).not.toBe(packageWorkdir(packageView));
    // ACP-arm cwd (workdir) collapses with it.
    expect(seen?.workdir).toBe(storyExecRoot(packageView));
    expect(seen?.workdir).toBe("/repo");
    expect(seen?.workdir).not.toBe("packages/api");
  });
});

describe("callOp root collapse — worktree-isolated story", () => {
  test("codingToolRoot and workdir are the worktree root, not the main checkout or package dir", async () => {
    const repoRoot = "/repo";
    const storyId = "US-007";
    let seen: AgentRunOptions | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        seen = req.runOptions;
        return { result: successResult, fallbacks: [], dispatchesCompleted: 1 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager(), workdir: repoRoot });
    createdRuntimes.push(runtime);

    // Resolve through the registry so packageDir carries the `.nax-wt/<storyId>`
    // prefix — the exact shape a worktree-isolated story produces.
    const packageView = runtime.packages.resolve(join(repoRoot, ".nax-wt", storyId, "packages", "api"));
    expect(packageView.repoRoot).toBe(repoRoot);
    expect(packageView.packageDir).toBe(".nax-wt/US-007/packages/api");
    const worktreeRoot = join(repoRoot, ".nax-wt", storyId);
    expect(storyExecRoot(packageView)).toBe(worktreeRoot);
    expect(packageWorkdir(packageView)).toBe(join(worktreeRoot, "packages", "api"));

    await callOp(
      { runtime, packageView, packageDir: packageView.packageDir, agentName: "claude", storyId },
      makeRunOp(),
      { text: "hi" },
    );

    expect(seen?.codingToolRoot).toBe(worktreeRoot);
    expect(seen?.codingToolRoot).not.toBe(repoRoot);
    expect(seen?.codingToolRoot).not.toBe(packageWorkdir(packageView));
    expect(seen?.workdir).toBe(worktreeRoot);
    expect(seen?.workdir).not.toBe(repoRoot);
  });
});

describe("callOp root collapse — complete-kind and hop context", () => {
  test("completeOptions.workdir is storyExecRoot, not ctx.packageDir", async () => {
    let seen: CompleteOptions | undefined;
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, _prompt, opts) => {
        seen = opts;
        return { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, workdir: "/repo" });
    createdRuntimes.push(runtime);
    const packageView = runtime.packages.resolve("packages/api");

    await callOp(
      { runtime, packageView, packageDir: "packages/api", agentName: "claude", storyId: "US-001" },
      makeCompleteOp(),
      { text: "hi" },
    );

    expect(seen?.workdir).toBe(storyExecRoot(packageView));
    expect(seen?.workdir).toBe("/repo");
    expect(seen?.workdir).not.toBe("packages/api");
  });

  test("hop context workdir is storyExecRoot, not ctx.packageDir", async () => {
    const orig = _callOpDeps.buildHopCallback;
    let seen: BuildHopCallbackContext | undefined;
    _callOpDeps.buildHopCallback = (hopCtx: BuildHopCallbackContext) => {
      seen = hopCtx;
      return async () => ({ result: successResult, bundle: undefined });
    };
    const agentManager = makeMockAgentManager({});
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager(), workdir: "/repo" });
    try {
      const packageView = runtime.packages.resolve("packages/api");
      await callOp(
        { runtime, packageView, packageDir: "packages/api", agentName: "claude", storyId: "US-001" },
        makeRunOp(),
        { text: "hi" },
      ).catch(() => undefined);
    } finally {
      _callOpDeps.buildHopCallback = orig;
      await runtime.close();
    }

    expect(seen?.workdir).toBe(storyExecRoot({ repoRoot: "/repo", packageDir: "packages/api" }));
    expect(seen?.workdir).toBe("/repo");
    expect(seen?.workdir).not.toBe("packages/api");
  });
});

// ---------------------------------------------------------------------------
// CallContext.signal (Task 4: caller-supplied abort signal)
// ---------------------------------------------------------------------------

let abortRuntime: NaxRuntime | undefined;
afterEach(async () => {
  await abortRuntime?.close();
});

function makeSignalCtx(runtime: NaxRuntime, extra?: Partial<CallContext>): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-001",
    ...extra,
  };
}

describe("callOp — CallContext.signal (Task 4: caller-supplied abort signal)", () => {
  const abortSel = pickSelector("finish-abort-test", "routing");

  function abortingOp(
    name: string,
    onRetry: () => void,
  ): RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
    return {
      kind: "run",
      name,
      stage: "review",
      config: abortSel,
      session: { role: "finish-review-spec", lifetime: "fresh" },
      build: () => ({
        role: { id: "role", content: "You retry.", overridable: false },
        task: { id: "task", content: "go", overridable: false },
      }),
      parse: (out) => out,
      retry: {
        shouldRetry: () => {
          onRetry();
          return { retry: true, delayMs: 0 };
        },
      },
    };
  }

  function makeHopInvokingAgentManager() {
    return makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: "File already valid.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const result = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return {
          result: {
            success: true,
            exitCode: 0,
            rateLimited: false,
            durationMs: 1,
            output: result.result.output,
            estimatedCostUsd: result.result.estimatedCostUsd ?? 0,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });
  }

  test("ctx.signal aborts a retry while runtime.signal is still live", async () => {
    const agentManager = makeHopInvokingAgentManager();
    const sessionManager = makeSessionManager();
    abortRuntime = makeTestRuntime({ agentManager, sessionManager });
    const caller = new AbortController();
    let attempts = 0;
    const op = abortingOp("test-caller-abort", () => {
      attempts += 1;
      caller.abort();
    });

    await expect(callOp(makeSignalCtx(abortRuntime, { signal: caller.signal }), op, { text: "x" })).rejects.toThrow(
      /aborted/,
    );
    expect(attempts).toBe(1);
  });

  test("with no ctx.signal, runtime.signal still aborts", async () => {
    const agentManager = makeHopInvokingAgentManager();
    const sessionManager = makeSessionManager();
    const parent = new AbortController();
    abortRuntime = makeTestRuntime({ agentManager, sessionManager, parentSignal: parent.signal });
    let attempts = 0;
    const op = abortingOp("test-runtime-abort", () => {
      attempts += 1;
      parent.abort();
    });

    await expect(callOp(makeSignalCtx(abortRuntime), op, { text: "x" })).rejects.toThrow(/aborted/);
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: timed-out / empty turns classify as fail-timeout / fail-stale
// ---------------------------------------------------------------------------

describe("callOp end-to-end — turn with timedOut=true is classified fail-timeout", () => {
  const timeoutSel = pickSelector("timeout-test", "routing");

  function makeTimeoutRunOp(name: string): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
    return {
      kind: "run",
      name,
      stage: "run",
      config: timeoutSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "You do the thing.", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (output) => output.trim(),
    };
  }

  const timeoutRuntimes: NaxRuntime[] = [];
  let origReadFileOutput: typeof _callOpDeps.readFileOutput;

  beforeEach(() => {
    origReadFileOutput = _callOpDeps.readFileOutput;
  });
  afterEach(async () => {
    _callOpDeps.readFileOutput = origReadFileOutput;
    await Promise.allSettled(timeoutRuntimes.map((r) => r.close()));
    timeoutRuntimes.length = 0;
  });

  test("timed-out turn produces fail-timeout (quality, retriable) — manager sees it", async () => {
    let capturedAdapterFailure: { outcome?: string; category?: string; retriable?: boolean } | undefined;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: typeof capturedAdapterFailure })
          .adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        timedOut: true,
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    timeoutRuntimes.push(runtime);

    let thrown: { code?: string } | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeTimeoutRunOp("timeout-op"),
        "hello",
      );
    } catch (err) {
      thrown = err as { code?: string };
    }

    expect(capturedAdapterFailure).toBeDefined();
    expect(capturedAdapterFailure?.outcome).toBe("fail-timeout");
    expect(capturedAdapterFailure?.category).toBe("quality");
    expect(capturedAdapterFailure?.retriable).toBe(true);
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("untimed empty turn still synthesises fail-stale (preserves legacy behavior)", async () => {
    let capturedAdapterFailure: { outcome?: string; category?: string; reason?: string } | undefined;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: typeof capturedAdapterFailure })
          .adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    timeoutRuntimes.push(runtime);

    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeTimeoutRunOp("empty-op"),
        "hello",
      );
    } catch {
      // expected: CALL_OP_NO_OUTPUT
    }

    expect(capturedAdapterFailure?.outcome).toBe("fail-stale");
    expect(capturedAdapterFailure?.category).toBe("availability");
    expect(capturedAdapterFailure?.reason).toBe("empty-output");
  });
});

// ---------------------------------------------------------------------------
// AgentRunOptions producers: codingToolRoot, outputDir, contextToolRunCounter
// ---------------------------------------------------------------------------

const mainCheckout = "/tmp/nax-pr6-coding-tool-repo-root";
const producerStoryId = "US-003";
const worktreePackageDir = join(mainCheckout, ".nax-wt", producerStoryId, "packages", "api");

function makeCodingToolRootOp(): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name: "coding-tool-root-producer",
    stage: "run",
    config: pickSelector("coding-tool-root-producer-test", "routing"),
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

describe("callOp produces AgentRunOptions.codingToolRoot", () => {
  test("points the containment root at the story worktree, not the main checkout", async () => {
    const seen: AgentRunOptions[] = [];
    const runtime = makeMockRuntime({
      workdir: mainCheckout,
      agentManager: makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          seen.push(req.runOptions);
          const { executeHop } = req;
          assertDefined(executeHop, "req.executeHop");
          const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
          return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
        },
        runAsSessionFn: async () => ({
          output: "done",
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        }),
      }),
    });
    createdRuntimes.push(runtime);

    const packageView = runtime.packages.resolve(worktreePackageDir);
    expect(packageView.repoRoot).toBe(mainCheckout);

    await callOp(
      { runtime, packageView, packageDir: worktreePackageDir, agentName: "claude" },
      makeCodingToolRootOp(),
      "input",
    );

    expect(seen.length).toBe(1);
    expect(seen[0]?.codingToolRoot).toBe(join(mainCheckout, ".nax-wt", producerStoryId));
    expect(seen[0]?.codingToolRoot).not.toBe(mainCheckout);
  });
});

function makeOutputDirOp(): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name: "output-dir-producer",
    stage: "run",
    config: pickSelector("output-dir-producer-test", "routing"),
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You process input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output,
  };
}

describe("callOp produces AgentRunOptions.outputDir", () => {
  test("hands the runtime's output dir to the dispatch that resolves coding tools", async () => {
    const seen: AgentRunOptions[] = [];
    const runtime = makeMockRuntime({
      agentManager: makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          seen.push(req.runOptions);
          const { executeHop } = req;
          assertDefined(executeHop, "req.executeHop");
          const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
          return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
        },
        runAsSessionFn: async () => ({
          output: "done",
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        }),
      }),
    });
    createdRuntimes.push(runtime);

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      makeOutputDirOp(),
      "input",
    );

    expect(seen.length).toBe(1);
    expect(seen[0]?.outputDir).toBe(runtime.outputDir);
    expect(seen[0]?.outputDir).not.toBe(seen[0]?.codingToolRoot);
  });
});

const runEchoCounterOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-counter-test",
  stage: "run",
  config: pickSelector("test", "routing"),
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

describe("callOp — contextToolRunCounter threading", () => {
  test("forwards ctx.contextToolRunCounter into the hop context", async () => {
    const orig = _callOpDeps.buildHopCallback;
    let seen: unknown;
    let stubCalled = false;
    _callOpDeps.buildHopCallback = (hopCtx: BuildHopCallbackContext) => {
      stubCalled = true;
      seen = hopCtx.contextToolRunCounter;
      return async () => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ok",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
        },
        bundle: undefined,
      });
    };

    const counter = createRunCallCounter();
    counter.count = 3;
    const agentManager = makeMockAgentManager({});
    const localRuntime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager({}) });
    try {
      await callOp(
        makeMockCallContext({
          runtime: localRuntime,
          packageView: localRuntime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          contextToolRunCounter: counter,
        }),
        runEchoCounterOp,
        { text: "hi" },
      ).catch(() => undefined);
    } finally {
      _callOpDeps.buildHopCallback = orig;
      await localRuntime.close();
    }

    expect({ stubCalled, seen }).toEqual({ stubCalled: true, seen: counter });
  });
});

/**
 * callOp — the per-story effective config, not the root config, reaches run options.
 *
 * nax#2066: callOp read ctx.runtime.configLoader.current() (root) while
 * codingToolRoot two lines below was package-correct, so RunCommand advertised
 * the ROOT quality.commands for a package story and ran the wrong toolchain.
 */

// The assertion field is `execution.permissionProfile`, not `quality.commands`,
// for two reasons. (1) `AgentRunOptions["config"]` is the narrow
// agentManagerConfigSelector Pick — `agent` / `execution` / `profile` — so
// reading `quality` off it would need a cast, and the looseCast ratchet fails
// on growth. (2) It is the field with the real consequence: it is what
// resolvePermissions reads, so this test pins the SEC-3 half of the change.

const effectiveConfigSel = pickSelector("effective-config-test", "routing");

const runEchoEffectiveConfigOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-effective-config",
  stage: "run",
  config: effectiveConfigSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

async function captureRunOptionsConfig(
  ctxConfig: NaxConfig | undefined,
): Promise<AgentRunOptions["config"] | undefined> {
  const orig = _callOpDeps.buildHopCallback;
  let seen: AgentRunOptions["config"] | undefined;
  _callOpDeps.buildHopCallback = (
    _hopCtx: BuildHopCallbackContext,
    _sessionId: string | undefined,
    runOptions: AgentRunOptions,
  ) => {
    seen = runOptions.config;
    return async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: "ok",
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: 0,
      },
      bundle: undefined,
    });
  };

  // "scoped" — deliberately NOT the schema default ("unrestricted"), so the
  // fallback test proves the value came from the runtime's root config rather
  // than from DEFAULT_CONFIG by coincidence.
  const rootConfig = makeNaxConfig({ execution: { permissionProfile: "scoped" } });
  const runtime = makeTestRuntime({
    config: rootConfig,
    agentManager: makeMockAgentManager({}),
    sessionManager: makeSessionManager({}),
  });
  try {
    await callOp(
      makeMockCallContext({
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        ...(ctxConfig ? { config: ctxConfig } : {}),
      }),
      runEchoEffectiveConfigOp,
      { text: "hi" },
    ).catch(() => undefined);
  } finally {
    _callOpDeps.buildHopCallback = orig;
    await runtime.close();
  }
  return seen;
}

describe("callOp — effective config reaches run options (#2066)", () => {
  test("ctx.config wins over the runtime's root config", async () => {
    const effective = makeNaxConfig({ execution: { permissionProfile: "safe" } });
    const seen = await captureRunOptionsConfig(effective);
    expect(seen?.execution?.permissionProfile).toBe("safe");
  });

  test("without ctx.config it still falls back to the root config", async () => {
    const seen = await captureRunOptionsConfig(undefined);
    expect(seen?.execution?.permissionProfile).toBe("scoped");
  });
});
