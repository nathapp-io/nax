import type { AgentAdapter } from "../agents";
import { resolveDefaultAgent } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import type { ContextBundle } from "../context/engine";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import type { InteractionChain } from "../interaction/chain";
import { getLogger } from "../logger";
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
import { parseSelfVerificationMarker } from "../quality";
import type { NaxRuntime } from "../runtime";
import type { SessionRole } from "../session/types";
import { _sessionRunnerDeps } from "./session-runner";
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
 * op.session.role. Does not call the legacy direct session runner.
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

  // Subscribe to dispatch events filtered by scopeId so we can surface this op's
  // tokenUsage AND raw response on TddSessionResult. Per adapter-wiring.md
  // Rule 6/7, cost/token data flows through DispatchEvent → middleware/listeners,
  // never via a manager overlay or CallContext back-channel.
  // Defensive: integration-test runtimes may omit costAggregator/dispatchEvents.
  // When absent, tokenUsage is unrecoverable — TddSessionResult.tokenUsage stays
  // undefined. The raw response is also unavailable, so selfVerification-marker
  // parsing is skipped.
  const scope = runtime.costAggregator?.openScope();
  let capturedTokenUsage: import("../agents/cost").TokenUsage | undefined;
  let capturedResponse = "";
  let capturedCostUsd = 0;
  const unsubscribe =
    runtime.dispatchEvents && scope
      ? runtime.dispatchEvents.onDispatch((event) => {
          if (event.scopeId === scope.scopeId) {
            if (event.tokenUsage) capturedTokenUsage = event.tokenUsage;
            if (event.response) capturedResponse = event.response;
            if (event.exactCostUsd !== undefined) capturedCostUsd += event.exactCostUsd;
            else if (event.estimatedCostUsd !== undefined) capturedCostUsd += event.estimatedCostUsd;
          }
        })
      : () => {};

  const packageView = runtime.packages.resolve(workdir);
  const ctx: CallContext = {
    runtime,
    packageView,
    packageDir: workdir,
    agentName: resolveDefaultAgent(runtime.configLoader.current()),
    storyId: story.id,
    featureName,
    story,
    ...(scope ? { scopeId: scope.scopeId } : {}),
    ...(interactionBridge ? { interactionBridge } : {}),
  };

  const startTime = Date.now();

  try {
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

    // Post-dispatch checks: mirror the legacy `runTddSession` path so callOp
    // dispatch produces equivalent TddSessionResults. Without these, isolation
    // violations, uncommitted agent edits, and self-verification markers are
    // silently dropped.
    await _sessionRunnerDeps.autoCommitIfDirty(workdir, "tdd", role, story.id);

    const lite = options.lite ?? false;
    const skipIsolation = lite && role !== "verifier";
    const testFilePatterns =
      typeof options.config.execution?.smartTestRunner === "object"
        ? options.config.execution.smartTestRunner?.testFilePatterns
        : undefined;

    let isolation: import("./types").IsolationCheck | undefined;
    if (!skipIsolation) {
      if (role === "test-writer") {
        const allowedPaths = options.config.tdd.testWriterAllowedPaths ?? ["src/index.ts", "src/**/index.ts"];
        isolation = await _sessionRunnerDeps.verifyTestWriterIsolation(
          workdir,
          _beforeRef,
          allowedPaths,
          testFilePatterns,
        );
      } else if (role === "implementer" || role === "verifier") {
        isolation = await _sessionRunnerDeps.verifyImplementerIsolation(workdir, _beforeRef, testFilePatterns);
      }
    }

    // Verifier inherits any isolation surfaced via the op's recover path
    // (verifierOp.recover reads .nax-verifier-verdict.json).
    if (!isolation && "isolation" in opOutput && opOutput.isolation) {
      isolation = opOutput.isolation;
    }

    const filesChanged =
      opOutput.filesChanged.length > 0
        ? opOutput.filesChanged
        : await _sessionRunnerDeps.getChangedFiles(workdir, _beforeRef);

    const selfVerificationResult =
      role === "verifier" || !capturedResponse ? undefined : parseSelfVerificationMarker(capturedResponse, workdir);
    const selfVerificationFailed =
      selfVerificationResult?.lint === "fail" || selfVerificationResult?.typecheck === "fail";

    if (isolation && !isolation.passed) {
      getLogger().error("tdd", "Isolation violated", {
        storyId: story.id,
        role,
        description: isolation.description,
        violations: isolation.violations,
      });
    }

    return {
      role,
      success: opOutput.success && (!isolation || isolation.passed) && !selfVerificationFailed,
      filesChanged,
      estimatedCostUsd: capturedCostUsd || opOutput.estimatedCostUsd,
      durationMs: opOutput.durationMs || Date.now() - startTime,
      ...(capturedTokenUsage ? { tokenUsage: capturedTokenUsage } : {}),
      ...(isolation ? { isolation } : {}),
      ...(selfVerificationResult ? { selfVerification: selfVerificationResult } : {}),
    };
  } finally {
    unsubscribe();
    scope?.close();
  }
}
