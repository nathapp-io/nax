import type { AgentAdapter } from "../agents";
import { resolveDefaultAgent } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { createConfigLoader, tddConfigSelector } from "../config";
import type { ContextBundle } from "../context/engine";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import type { InteractionChain } from "../interaction/chain";
import {
  callOp,
  implementTddOp,
  implementerOp,
  testWriterOp,
  verifierOp,
  verifyTddOp,
  writeTddTestOp,
} from "../operations";
import type {
  CallContext,
  ImplementerInput,
  ImplementerOutput,
  TestWriterInput,
  TestWriterOutput,
  VerifierInput,
  VerifierOutput,
} from "../operations";
import type { UserStory } from "../prd";
import type { NaxRuntime } from "../runtime";
import type { SessionRole } from "../session/types";
import { runTddSession } from "./session-runner";
import type { TddSessionBinding } from "./session-runner";
import type { TddSessionResult, TddSessionRole } from "./types";

export { implementTddOp, implementerOp, verifyTddOp, verifierOp, writeTddTestOp, testWriterOp };

/** Subset of ThreeSessionTddOptions needed by runTddSessionOp */
export interface TddSessionOpOptions {
  agent: AgentAdapter;
  agentManager: import("../agents/manager-types").IAgentManager;
  story: UserStory;
  config: NaxConfig;
  workdir: string;
  modelTier: ModelTier;
  /**
   * Runtime for constructing CallContext for callOp dispatch.
   * Optional — when absent, falls back to the legacy runTddSession path.
   */
  runtime?: NaxRuntime;
  featureName?: string;
  contextMarkdown?: string;
  featureContextMarkdown?: string;
  constitution?: string;
  lite?: boolean;
  interactionChain?: InteractionChain | null;
  projectDir?: string;
  abortSignal?: AbortSignal;
  dryRun?: boolean;
}

/** Op shape accepted by runTddSessionOp — matches RunOperation.session (uses broad SessionRole). */
type TddSessionOp = { readonly session: { readonly role: SessionRole } };

/**
 * Run a single TDD session for the given op (role).
 *
 * When `runtime` is provided, dispatches via callOp (full middleware chain).
 * When `runtime` is absent (e.g. integration tests without a runtime), falls back
 * to runTddSession directly so mock adapters returning empty output still work.
 */
export async function runTddSessionOp(
  op: TddSessionOp,
  options: TddSessionOpOptions,
  _beforeRef: string,
  _contextBundle?: ContextBundle,
  _sessionBinding?: TddSessionBinding,
): Promise<TddSessionResult> {
  const {
    story,
    workdir,
    featureName,
    contextMarkdown,
    featureContextMarkdown,
    constitution,
    interactionChain,
    runtime,
  } = options;

  const role = op.session.role as TddSessionRole;
  const includeContext = role !== "verifier";

  const interactionBridge = includeContext
    ? buildInteractionBridge(interactionChain, { featureName, storyId: story.id, stage: "execution" })
    : undefined;

  // Legacy path: when runtime is absent OR incomplete (no agentManager), use runTddSession
  // directly. Integration tests predate the callOp dispatch path and use mock adapters
  // that return empty output, which callOp rejects with CALL_OP_NO_OUTPUT. Partial mock
  // runtimes (e.g. with only sessionManager) are also routed here so they don't crash.
  if (!runtime?.agentManager) {
    const tddConfig = tddConfigSelector.select(options.config);
    // In lite mode, skip isolation for test-writer and implementer; verifier always checks.
    const lite = options.lite ?? false;
    const skipIsolation = lite && role !== "verifier";
    return runTddSession(
      role,
      options.agent,
      options.agentManager,
      story,
      tddConfig,
      workdir,
      options.modelTier,
      _beforeRef,
      contextMarkdown,
      lite,
      skipIsolation,
      constitution,
      featureName,
      interactionBridge,
      options.projectDir,
      featureContextMarkdown,
      _contextBundle,
      _sessionBinding,
      options.abortSignal,
    );
  }

  // callOp path: intercept runWithFallback to capture tokenUsage from the AgentRunOutcome.
  // callOp returns only the parsed O and does not surface tokenUsage in its return value.
  // Object.create delegates all other methods to origManager via prototype chain.
  // Fall back to options.agentManager when the runtime has a partial mock (no agentManager field).
  let capturedTokenUsage: import("../agents/cost").TokenUsage | undefined;
  const origManager = runtime.agentManager ?? options.agentManager;
  const captureManager = Object.create(origManager) as import("../agents/manager-types").IAgentManager;
  captureManager.runWithFallback = async (req, primaryAgentOverride) => {
    const outcome = await origManager.runWithFallback(req, primaryAgentOverride);
    if (outcome.result.tokenUsage) capturedTokenUsage = outcome.result.tokenUsage;
    return outcome;
  };

  // runtime.packages may be absent on partial mock runtimes in integration tests.
  const packageView = runtime.packages?.resolve(workdir) ?? {
    packageDir: workdir,
    relativeFromRoot: "",
    config: options.config,
    select<C>(selector: import("../config").ConfigSelector<C>): C {
      return selector.select(options.config);
    },
  };
  const agentName = resolveDefaultAgent(options.config);
  // Spread runtime and backfill any fields absent in partial mock runtimes.
  const effectiveRuntime: NaxRuntime = {
    ...runtime,
    agentManager: captureManager,
    configLoader: runtime.configLoader ?? createConfigLoader(options.config),
  } as NaxRuntime;
  const ctx: CallContext = {
    runtime: effectiveRuntime,
    packageView,
    packageDir: workdir,
    agentName,
    storyId: story.id,
    featureName,
    story,
    ...(interactionBridge ? { interactionBridge } : {}),
  };

  const startTime = Date.now();

  let opOutput: ImplementerOutput | TestWriterOutput | VerifierOutput;
  if (role === "test-writer") {
    const input: TestWriterInput = {
      story,
      ...(includeContext ? { contextMarkdown, featureContextMarkdown, constitution } : {}),
    };
    opOutput = await callOp(ctx, testWriterOp, input);
  } else if (role === "implementer") {
    const input: ImplementerInput = {
      story,
      ...(includeContext ? { contextMarkdown, featureContextMarkdown, constitution } : {}),
    };
    opOutput = await callOp(ctx, implementerOp, input);
  } else {
    const input: VerifierInput = { story };
    opOutput = await callOp(ctx, verifierOp, input);
  }

  return {
    role,
    success: opOutput.success,
    filesChanged: opOutput.filesChanged,
    estimatedCostUsd: opOutput.estimatedCostUsd,
    durationMs: opOutput.durationMs || Date.now() - startTime,
    ...(capturedTokenUsage ? { tokenUsage: capturedTokenUsage } : {}),
    ...("isolation" in opOutput && opOutput.isolation ? { isolation: opOutput.isolation } : {}),
  };
}
