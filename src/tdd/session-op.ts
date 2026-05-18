import type { AgentAdapter } from "../agents";
import { resolveDefaultAgent } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
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
  /** Runtime for constructing CallContext for callOp dispatch. */
  runtime: NaxRuntime;
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
 * Dispatches via callOp to implementerOp, testWriterOp, or verifierOp based on
 * op.session.role. Does not call runTddSession() directly.
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

  // Intercept runWithFallback to capture tokenUsage from the AgentRunOutcome.
  // callOp returns only the parsed O and does not surface tokenUsage in its return value.
  // Object.create delegates all other methods to origManager via prototype chain.
  let capturedTokenUsage: import("../agents/cost").TokenUsage | undefined;
  const origManager = runtime.agentManager;
  const captureManager = Object.create(origManager) as import("../agents/manager-types").IAgentManager;
  captureManager.runWithFallback = async (req, primaryAgentOverride) => {
    const outcome = await origManager.runWithFallback(req, primaryAgentOverride);
    if (outcome.result.tokenUsage) capturedTokenUsage = outcome.result.tokenUsage;
    return outcome;
  };

  const packageView = runtime.packages.resolve(workdir);
  const ctx: CallContext = {
    runtime: { ...runtime, agentManager: captureManager } as NaxRuntime,
    packageView,
    packageDir: workdir,
    agentName: resolveDefaultAgent(runtime.configLoader.current()),
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
