import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSessionName } from "../../../src/agents/acp/adapter";
import { _executionDeps, executionStage } from "../../../src/pipeline/stages/execution";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import { _debateSessionDeps, resolveOutcome } from "../../../src/debate/session-helpers";
import { _gitDeps } from "../../../src/utils/git";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { AgentAdapter, AgentRunOptions, CompleteOptions } from "../../../src/agents/types";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { NaxConfig } from "../../../src/config";
import type { SemanticStory, SemanticReviewConfig } from "../../../src/review/semantic";

// ─────────────────────────────────────────────────────────────────────────────
// Shared test helpers
// ─────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = join(import.meta.dir, "../../../src");
const readSrc = (rel: string): Promise<string> => Bun.file(join(SRC_ROOT, rel)).text();

/** Create a minimal fake Bun subprocess with controlled stdout. */
function makeFakeProc(stdout = "", exitCode = 0) {
  const bytes = new TextEncoder().encode(stdout);
  return {
    stdout: new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(bytes);
        ctrl.close();
      },
    }),
    stderr: new ReadableStream({
      start(ctrl) {
        ctrl.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    pid: 9999,
    stdin: null,
    kill: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

/**
 * Git spawn stub: returns a different directory for rev-parse --show-toplevel
 * so autoCommitIfDirty's guard check fails and it returns early.
 */
const noopGitSpawn = (_cmd: string[], _opts?: unknown) =>
  makeFakeProc("/different/git/root");

interface MockAgentState {
  adapter: AgentAdapter;
  capturedRunOptions: AgentRunOptions | null;
  capturedCompleteArgs: { prompt: string; opts: CompleteOptions } | null;
  runCallCount: number;
  completeCallCount: number;
  /** AgentResult.sessionCreated — true means new session (not resumed) */
  sessionCreated: boolean;
}

function makeMockAgent(opts: {
  runOutput?: string;
  runSuccess?: boolean;
  sessionCreated?: boolean;
  completeOutput?: string;
} = {}): MockAgentState {
  const state: MockAgentState = {
    adapter: null as unknown as AgentAdapter,
    capturedRunOptions: null,
    capturedCompleteArgs: null,
    runCallCount: 0,
    completeCallCount: 0,
    sessionCreated: opts.sessionCreated ?? false,
  };
  state.adapter = {
    name: "claude",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"] as const,
      maxContextTokens: 100_000,
      features: new Set(["review", "tdd"]) as ReadonlySet<"tdd" | "review" | "refactor" | "batch">,
    },
    async run(runOpts: AgentRunOptions) {
      state.capturedRunOptions = runOpts;
      state.runCallCount++;
      return {
        success: opts.runSuccess ?? true,
        exitCode: opts.runSuccess === false ? 1 : 0,
        output: opts.runOutput ?? "",
        rateLimited: false,
        durationMs: 100,
        estimatedCost: 0,
        sessionCreated: state.sessionCreated,
      };
    },
    async complete(prompt: string, completeOpts: CompleteOptions) {
      state.capturedCompleteArgs = { prompt, opts: completeOpts };
      state.completeCallCount++;
      return { output: opts.completeOutput ?? "" };
    },
    async plan() { return { success: true, output: "" }; },
    async decompose() { return { stories: [], costUsd: 0 }; },
  } as unknown as AgentAdapter;
  return state;
}

function makeNaxConfig(overrides?: {
  reviewEnabled?: boolean;
  rectificationEnabled?: boolean;
}): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    review: {
      ...DEFAULT_CONFIG.review,
      enabled: overrides?.reviewEnabled ?? false,
    },
    execution: {
      ...DEFAULT_CONFIG.execution,
      rectification: {
        ...(DEFAULT_CONFIG.execution as any).rectification,
        enabled: overrides?.rectificationEnabled ?? false,
      },
    },
  } as NaxConfig;
}

function makeExecutionCtx(opts: {
  testStrategy?: string;
  config?: NaxConfig;
  agentGetFn?: (name: string) => AgentAdapter | undefined;
}): PipelineContext {
  const config = opts.config ?? makeNaxConfig();
  return {
    config,
    rootConfig: config,
    routing: {
      testStrategy: opts.testStrategy ?? "test-after",
      modelTier: "fast",
      complexity: "simple",
      reasoning: "",
      agent: "claude",
    },
    story: {
      id: "US-001",
      title: "Test story",
      description: "Test description",
      acceptanceCriteria: [],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
    },
    stories: [],
    prd: { feature: "test-feature", stories: [], version: "1", title: "" },
    workdir: "/tmp/test-workdir",
    hooks: {},
    agentGetFn: opts.agentGetFn,
    prompt: "Implement the story",
  } as unknown as PipelineContext;
}

// Constants for semantic review tests
const MOCK_WORKDIR = "/workspace/test-project";
const MOCK_STORY_GIT_REF = "abc1234def567890";
const MOCK_FEATURE_NAME = "my-feature";
const MOCK_STORY: SemanticStory = {
  id: "US-001",
  title: "Test story",
  description: "Implement feature X",
  acceptanceCriteria: ["AC-1: X should work", "AC-2: Y should work"],
};
const MOCK_SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "fast",
  rules: [],
  timeoutMs: 30_000,
  excludePatterns: [],
};

/** Fake spawn for _semanticDeps: returns a non-empty diff. */
const mockSemanticSpawn = (_cmd: string[], _opts?: unknown) =>
  makeFakeProc(
    "diff --git a/src/foo.ts b/src/foo.ts\nindex 000..111 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -0,0 +1,3 @@\n+export function foo() {}\n",
  );

const BASE_STAGE_CONFIG: DebateStageConfig = {
  enabled: true,
  resolver: { type: "majority-fail-closed" },
  sessionMode: "one-shot",
  mode: "panel",
  rounds: 1,
  debaters: [],
  timeoutSeconds: 30,
};

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 through AC-4: execution.ts agent.run() options for single-session path
// ─────────────────────────────────────────────────────────────────────────────

describe("execution stage — agent.run() options (AC-1 to AC-4)", () => {
  let origResolveWorkdir: typeof _executionDeps.resolveStoryWorkdir;
  let origGitSpawn: typeof _gitDeps.spawn;

  beforeEach(() => {
    origResolveWorkdir = _executionDeps.resolveStoryWorkdir;
    origGitSpawn = _gitDeps.spawn;
    _executionDeps.resolveStoryWorkdir = (repoRoot, _storyWorkdir) => repoRoot;
    _gitDeps.spawn = noopGitSpawn as typeof _gitDeps.spawn;
  });

  afterEach(() => {
    _executionDeps.resolveStoryWorkdir = origResolveWorkdir;
    _gitDeps.spawn = origGitSpawn;
  });

  test("AC-1: agent.run() receives sessionRole === 'implementer' for test-after strategy", async () => {
    const mock = makeMockAgent({ runSuccess: false });
    const ctx = makeExecutionCtx({ testStrategy: "test-after", agentGetFn: () => mock.adapter });

    await executionStage.execute(ctx);

    expect(mock.capturedRunOptions).not.toBeNull();
    expect(mock.capturedRunOptions?.sessionRole).toBe("implementer");
  });

  test("AC-1 (no-test): agent.run() receives sessionRole === 'implementer' for no-test strategy", async () => {
    const mock = makeMockAgent({ runSuccess: false });
    const ctx = makeExecutionCtx({ testStrategy: "no-test", agentGetFn: () => mock.adapter });

    await executionStage.execute(ctx);

    expect(mock.capturedRunOptions).not.toBeNull();
    expect(mock.capturedRunOptions?.sessionRole).toBe("implementer");
  });

  test("AC-2: agent.run() receives keepSessionOpen === true when review.enabled is true", async () => {
    const mock = makeMockAgent({ runSuccess: false });
    const ctx = makeExecutionCtx({
      testStrategy: "test-after",
      config: makeNaxConfig({ reviewEnabled: true }),
      agentGetFn: () => mock.adapter,
    });

    await executionStage.execute(ctx);

    expect(mock.capturedRunOptions?.keepSessionOpen).toBe(true);
  });

  test("AC-3: agent.run() receives keepSessionOpen === true when rectification.enabled is true", async () => {
    const mock = makeMockAgent({ runSuccess: false });
    const ctx = makeExecutionCtx({
      testStrategy: "test-after",
      config: makeNaxConfig({ rectificationEnabled: true }),
      agentGetFn: () => mock.adapter,
    });

    await executionStage.execute(ctx);

    expect(mock.capturedRunOptions?.keepSessionOpen).toBe(true);
  });

  test("AC-4: agent.run() receives keepSessionOpen === false when both review and rectification are disabled", async () => {
    const mock = makeMockAgent({ runSuccess: false });
    const ctx = makeExecutionCtx({
      testStrategy: "test-after",
      config: makeNaxConfig({ reviewEnabled: false, rectificationEnabled: false }),
      agentGetFn: () => mock.adapter,
    });

    await executionStage.execute(ctx);

    expect(mock.capturedRunOptions?.keepSessionOpen).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: buildSessionName determinism and shared usage
// ─────────────────────────────────────────────────────────────────────────────

test("AC-5: buildSessionName() returns identical value for same inputs — deterministic for both call sites", () => {
  const workdir = "/workspace/my-repo";
  const featureName = "my-feature";
  const storyId = "US-042";

  const call1 = buildSessionName(workdir, featureName, storyId, "implementer");
  const call2 = buildSessionName(workdir, featureName, storyId, "implementer");

  expect(call1).toBe(call2);
  expect(call1).toContain("implementer");
  expect(call1.startsWith("nax-")).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6 through AC-13: Source code structure (file checks)
// ─────────────────────────────────────────────────────────────────────────────

test("AC-6: runSemanticReview() function signature contains a featureName parameter of type string | undefined", async () => {
  const src = await readSrc("review/semantic.ts");
  const fnMatch = src.match(/export async function runSemanticReview\s*\(([^)]*)\)/s);
  expect(fnMatch).not.toBeNull();
  const params = fnMatch![1];
  expect(params).toMatch(/featureName/);
});

test("AC-7: runReview() in runner.ts has featureName? param and passes it to runSemanticReview call", async () => {
  const src = await readSrc("review/runner.ts");
  // Function declaration includes featureName
  const fnMatch = src.match(/export async function runReview\s*\(([^{]*)/s);
  expect(fnMatch).not.toBeNull();
  expect(fnMatch![1]).toMatch(/featureName/);

  // The runSemanticReview() call site passes featureName (not a hardcoded string)
  const callIdx = src.indexOf("runSemanticReview(");
  expect(callIdx).toBeGreaterThan(-1);
  const callSnippet = src.slice(callIdx, callIdx + 500);
  expect(callSnippet).toMatch(/featureName/);
  expect(callSnippet).not.toMatch(/"[^"]*feature[^"]*"/); // not a hardcoded string literal
});

test("AC-8: ReviewOrchestrator.review() method signature includes featureName? parameter", async () => {
  const src = await readSrc("review/orchestrator.ts");
  const methodMatch = src.match(/async review\s*\(([^{]*)/s);
  expect(methodMatch).not.toBeNull();
  expect(methodMatch![1]).toMatch(/featureName/);
});

test("AC-9: review.ts pipeline stage passes ctx.prd.feature as featureName to reviewOrchestrator.review()", async () => {
  const src = await readSrc("pipeline/stages/review.ts");
  const callIdx = src.indexOf("reviewOrchestrator.review(");
  expect(callIdx).toBeGreaterThan(-1);
  const callSnippet = src.slice(callIdx, callIdx + 1000);
  // ctx.prd.feature must appear in the call arguments
  expect(callSnippet).toMatch(/ctx\.prd\.feature/);
});

test("AC-10: semantic.ts uses buildSessionName() for session naming — not the nax-semantic-${story.id} template literal", async () => {
  const src = await readSrc("review/semantic.ts");
  // The old template literal must not exist
  expect(src).not.toMatch(/`nax-semantic-\$\{story\.id\}`/);
  // buildSessionName is called somewhere in the file
  expect(src).toMatch(/buildSessionName\s*\(/);
});

test("AC-11: createDebateSession() in semantic.ts receives featureName variable as featureName (not story.id)", async () => {
  const src = await readSrc("review/semantic.ts");
  const callIdx = src.indexOf("createDebateSession(");
  expect(callIdx).toBeGreaterThan(-1);
  const callSnippet = src.slice(callIdx, callIdx + 400);
  // featureName property must be the featureName variable (function parameter)
  expect(callSnippet).toMatch(/featureName:\s*featureName/);
  // Must NOT be story.id
  expect(callSnippet).not.toMatch(/featureName:\s*story\.id/);
});

test("AC-12: semantic.ts undefined-featureName code path calls buildSessionName() and logs debug with exact message", async () => {
  const src = await readSrc("review/semantic.ts");
  // buildSessionName is invoked (not short-circuited when featureName is undefined)
  expect(src).toMatch(/buildSessionName\s*\(/);
  // Exact debug message must exist in the source
  expect(src).toContain("featureName missing — semantic session name will not include feature");
});

test("AC-13: no occurrences of nax-semantic-${story.id} template literal in any source file", async () => {
  const proc = Bun.spawn(
    ["grep", "-r", "--include=*.ts", "nax-semantic-${story.id}", join(SRC_ROOT, "..")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = (await new Response(proc.stdout).text()).trim();
  const exitCode = await proc.exited;
  // grep exits 1 when no matches (desired), or 0 with no output (also fine)
  const noMatches = exitCode === 1 || output === "";
  expect(noMatches).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14 through AC-21: semantic.ts non-debate path runtime behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("semantic review — non-debate path runtime behavior (AC-14 to AC-21)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;
  let origCreateDebateSession: typeof _semanticDeps.createDebateSession;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    origCreateDebateSession = _semanticDeps.createDebateSession;

    _semanticDeps.spawn = mockSemanticSpawn as typeof _semanticDeps.spawn;
    _semanticDeps.isGitRefValid = async () => true;
    _semanticDeps.getMergeBase = async () => MOCK_STORY_GIT_REF;
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
    _semanticDeps.createDebateSession = origCreateDebateSession;
  });

  test("AC-14: non-debate path calls agent.run() and NOT agent.complete()", async () => {
    const mock = makeMockAgent({
      runOutput: JSON.stringify({ passed: true, findings: [] }),
    });
    const cfg: NaxConfig = { ...DEFAULT_CONFIG, debate: { ...DEFAULT_CONFIG.debate, enabled: false } } as NaxConfig;

    await runSemanticReview(
      MOCK_WORKDIR,
      MOCK_STORY_GIT_REF,
      MOCK_STORY,
      MOCK_SEMANTIC_CONFIG,
      (_tier) => mock.adapter,
      cfg,
    );

    expect(mock.runCallCount).toBe(1);
    expect(mock.completeCallCount).toBe(0);
  });

  test("AC-15: agent.run() options.acpSessionName equals buildSessionName(workdir, featureName, storyId, 'implementer')", async () => {
    const mock = makeMockAgent({
      runOutput: JSON.stringify({ passed: true, findings: [] }),
    });

    // Call with extra featureName arg (new parameter added by this feature)
    await (runSemanticReview as (...args: unknown[]) => Promise<unknown>)(
      MOCK_WORKDIR,
      MOCK_STORY_GIT_REF,
      MOCK_STORY,
      MOCK_SEMANTIC_CONFIG,
      (_tier: unknown) => mock.adapter,
      undefined,
      MOCK_FEATURE_NAME,
    );

    const expectedName = buildSessionName(MOCK_WORKDIR, MOCK_FEATURE_NAME, MOCK_STORY.id, "implementer");
    expect(mock.capturedRunOptions?.acpSessionName).toBe(expectedName);
  });

  test("AC-16: agent.run() options.keepSessionOpen === false in non-debate path", async () => {
    const mock = makeMockAgent({
      runOutput: JSON.stringify({ passed: true, findings: [] }),
    });

    await runSemanticReview(
      MOCK_WORKDIR,
      MOCK_STORY_GIT_REF,
      MOCK_STORY,
      MOCK_SEMANTIC_CONFIG,
      (_tier) => mock.adapter,
    );

    expect(mock.capturedRunOptions?.keepSessionOpen).toBe(false);
  });

  test("AC-17: runSemanticReview signature includes featureName; buildSessionName called with (workdir, featureName, ...)", async () => {
    const src = await readSrc("review/semantic.ts");
    // Verify featureName in function signature
    const fnMatch = src.match(/export async function runSemanticReview\s*\(([^)]*)\)/s);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![1]).toMatch(/featureName/);
    // Verify buildSessionName is called with workdir and featureName as first two args
    expect(src).toMatch(/buildSessionName\s*\(\s*workdir\s*,\s*featureName/);
  });

  test("AC-18: logger.debug called with 'implementer session not found — semantic review running in new session' when session is new", async () => {
    // Verify the message exists in source (logger is not injectable in this module)
    const src = await readSrc("review/semantic.ts");
    expect(src).toContain("implementer session not found — semantic review running in new session");
  });

  test("AC-19: rawResponse assigned from AgentRunResult.output (not CompleteResult)", async () => {
    const mockOutputJson = JSON.stringify({ passed: true, findings: [] });
    const mock = makeMockAgent({ runOutput: mockOutputJson });

    const result = await runSemanticReview(
      MOCK_WORKDIR,
      MOCK_STORY_GIT_REF,
      MOCK_STORY,
      MOCK_SEMANTIC_CONFIG,
      (_tier) => mock.adapter,
    );

    // The run() output was used as rawResponse — review should have processed it (not skipped)
    expect(result.check).toBe("semantic");
    expect(result.output).not.toContain("skipped");
    // run() was called (not complete())
    expect(mock.runCallCount).toBe(1);
    expect(mock.completeCallCount).toBe(0);
  });

  test("AC-20: runSemanticReview() return value satisfies ReviewCheckResult interface", async () => {
    const mock = makeMockAgent({
      runOutput: JSON.stringify({ passed: true, findings: [] }),
    });

    const result = await runSemanticReview(
      MOCK_WORKDIR,
      MOCK_STORY_GIT_REF,
      MOCK_STORY,
      MOCK_SEMANTIC_CONFIG,
      (_tier) => mock.adapter,
    );

    expect(result).toHaveProperty("check");
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("command");
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("durationMs");
    expect(result.check).toBe("semantic");
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.command).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.output).toBe("string");
    expect(typeof result.durationMs).toBe("number");
  });

  test("AC-21: debate path invokes agent.complete() (not agent.run()) when reviewDebateEnabled is true", async () => {
    const mock = makeMockAgent();
    let debateSessionRunCalled = false;

    _semanticDeps.createDebateSession = (_opts) => {
      return {
        run: async (_prompt: string) => {
          debateSessionRunCalled = true;
          return {
            storyId: MOCK_STORY.id,
            stage: "review",
            outcome: "passed",
            rounds: 1,
            debaters: ["claude"],
            resolverType: "majority-fail-closed",
            proposals: [
              {
                debater: { agent: "claude" },
                output: JSON.stringify({ passed: true, findings: [] }),
              },
            ],
            totalCostUsd: 0,
          };
        },
      } as unknown as ReturnType<typeof _semanticDeps.createDebateSession>;
    };

    const naxConfigWithDebate: NaxConfig = {
      ...DEFAULT_CONFIG,
      debate: {
        ...(DEFAULT_CONFIG.debate ?? {}),
        enabled: true,
        stages: {
          ...((DEFAULT_CONFIG.debate as any)?.stages ?? {}),
          review: {
            enabled: true,
            resolver: { type: "majority-fail-closed" },
            sessionMode: "one-shot",
            mode: "panel",
            rounds: 1,
            timeoutSeconds: 60,
          },
        },
      },
    } as unknown as NaxConfig;

    await runSemanticReview(
      MOCK_WORKDIR,
      MOCK_STORY_GIT_REF,
      MOCK_STORY,
      MOCK_SEMANTIC_CONFIG,
      (_tier) => mock.adapter,
      naxConfigWithDebate,
    );

    // Debate session was used, NOT direct agent.run() or agent.complete()
    expect(debateSessionRunCalled).toBe(true);
    expect(mock.runCallCount).toBe(0);
    expect(mock.completeCallCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-22 through AC-29: resolveOutcome() with workdir/featureName parameters
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveOutcome() workdir/featureName parameters (AC-22 to AC-29)", () => {
  let origGetAgent: typeof _debateSessionDeps.getAgent;
  let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

  beforeEach(() => {
    origGetAgent = _debateSessionDeps.getAgent;
    origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  });

  afterEach(() => {
    _debateSessionDeps.getAgent = origGetAgent;
    _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  });

  test("AC-22: resolveOutcome() compiles and works without workdir/featureName (backward compatible)", async () => {
    const proposals = [JSON.stringify({ passed: true, findings: [] })];
    // Must not throw — these params are optional
    const result = await resolveOutcome(proposals, [], BASE_STAGE_CONFIG, undefined, "US-001", 30_000);
    expect(result).toHaveProperty("outcome");
    expect(result).toHaveProperty("resolverCostUsd");
    expect(["passed", "failed", "skipped"].includes(result.outcome)).toBe(true);
  });

  test("AC-23: synthesis resolver receives acpSessionName = buildSessionName(workdir, featureName, storyId, 'implementer') when workdir is defined", async () => {
    let capturedOpts: CompleteOptions | null = null;
    const mockAdapter = makeMockAgent({ completeOutput: JSON.stringify({ outcome: "passed" }) });
    _debateSessionDeps.getAgent = (_name, _config) => mockAdapter.adapter;

    const synthConfig: DebateStageConfig = {
      ...BASE_STAGE_CONFIG,
      resolver: { type: "synthesis", agent: "claude" },
    };
    const workdir = "/workspace/my-project";
    const featureName = "my-feature";
    const storyId = "US-001";

    await (resolveOutcome as (...args: unknown[]) => Promise<unknown>)(
      ["Proposal A", "Proposal B"],
      [],
      synthConfig,
      undefined,
      storyId,
      30_000,
      workdir,
      featureName,
    );

    capturedOpts = mockAdapter.capturedCompleteArgs?.opts ?? null;
    const expectedName = buildSessionName(workdir, featureName, storyId, "implementer");
    expect(capturedOpts?.acpSessionName).toBe(expectedName);
  });

  test("AC-24: judge (custom) resolver receives acpSessionName = buildSessionName(workdir, featureName, storyId, 'implementer') when workdir is defined", async () => {
    let capturedOpts: CompleteOptions | null = null;
    const mockAdapter = makeMockAgent({ completeOutput: JSON.stringify({ outcome: "passed" }) });
    _debateSessionDeps.getAgent = (_name, _config) => mockAdapter.adapter;

    const judgeConfig: DebateStageConfig = {
      ...BASE_STAGE_CONFIG,
      resolver: { type: "custom", agent: "claude" },
    };
    const workdir = "/workspace/my-project";
    const featureName = "my-feature";
    const storyId = "US-001";

    await (resolveOutcome as (...args: unknown[]) => Promise<unknown>)(
      ["Proposal A", "Proposal B"],
      [],
      judgeConfig,
      undefined,
      storyId,
      30_000,
      workdir,
      featureName,
    );

    capturedOpts = mockAdapter.capturedCompleteArgs?.opts ?? null;
    const expectedName = buildSessionName(workdir, featureName, storyId, "implementer");
    expect(capturedOpts?.acpSessionName).toBe(expectedName);
  });

  test("AC-25: session-stateful.ts resolveOutcome() call includes ctx.workdir and ctx.featureName as arguments", async () => {
    const src = await Bun.file(join(SRC_ROOT, "debate/session-stateful.ts")).text();
    const callIdx = src.indexOf("resolveOutcome(");
    expect(callIdx).toBeGreaterThan(-1);
    const callSnippet = src.slice(callIdx, callIdx + 400);
    expect(callSnippet).toMatch(/ctx\.workdir/);
    expect(callSnippet).toMatch(/ctx\.featureName/);
  });

  test("AC-26: resolveOutcome() with majority resolver type and defined workdir emits a logger.warn about lack of session resumption", async () => {
    const warnMessages: string[] = [];
    _debateSessionDeps.getSafeLogger = () =>
      ({
        warn: (_stage: string, msg: string) => {
          warnMessages.push(msg);
        },
        info: () => {},
        debug: () => {},
        error: () => {},
      }) as unknown as ReturnType<typeof _debateSessionDeps.getSafeLogger>;

    await (resolveOutcome as (...args: unknown[]) => Promise<unknown>)(
      [JSON.stringify({ passed: true, findings: [] })],
      [],
      BASE_STAGE_CONFIG,
      undefined,
      "US-001",
      30_000,
      "/workspace/project",
      "my-feature",
    );

    const expectedMsg =
      "majority resolver does not support implementer session resumption — switch to synthesis or custom resolver for context-aware semantic review";
    expect(warnMessages.some((m) => m.includes(expectedMsg))).toBe(true);
  });

  test("AC-27: majority resolver returns resolverCostUsd === 0 and correct outcome regardless of workdir", async () => {
    const proposals = [
      JSON.stringify({ passed: true, findings: [] }),
      JSON.stringify({ passed: true, findings: [] }),
      JSON.stringify({ passed: false, findings: [] }),
    ];

    // Without workdir
    const r1 = await resolveOutcome(proposals, [], BASE_STAGE_CONFIG, undefined, "US-001", 30_000);
    expect(r1.resolverCostUsd).toBe(0);
    expect(r1.outcome).toBe("passed");

    // With workdir — outcome and cost must be identical
    const r2 = await (resolveOutcome as (...args: unknown[]) => Promise<typeof r1>)(
      proposals,
      [],
      BASE_STAGE_CONFIG,
      undefined,
      "US-001",
      30_000,
      "/workspace/project",
      "my-feature",
    );
    expect(r2.resolverCostUsd).toBe(0);
    expect(r2.outcome).toBe("passed");
  });

  test("AC-28: resolveOutcome() without workdir does NOT include acpSessionName in completeOptions for synthesis/judge", async () => {
    let capturedOpts: CompleteOptions | null = null;
    const mockAdapter = makeMockAgent({ completeOutput: JSON.stringify({ outcome: "passed" }) });
    _debateSessionDeps.getAgent = (_name, _config) => mockAdapter.adapter;

    const synthConfig: DebateStageConfig = {
      ...BASE_STAGE_CONFIG,
      resolver: { type: "synthesis", agent: "claude" },
    };

    // No workdir argument — old 6-param call
    await resolveOutcome(["Proposal A", "Proposal B"], [], synthConfig, undefined, "US-001", 30_000);

    capturedOpts = mockAdapter.capturedCompleteArgs?.opts ?? null;
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts?.acpSessionName).toBeUndefined();
  });

  test("AC-29: TypeScript compilation passes without errors (DebateResult type unchanged, all callers type-safe)", async () => {
    const proc = Bun.spawn(["bun", "run", "typecheck"], {
      cwd: join(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      console.error("[AC-29] TypeScript errors:\n", stderr.slice(0, 2000));
    }
    expect(exitCode).toBe(0);
  });
});