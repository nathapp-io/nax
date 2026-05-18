import type { AgentAdapter } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import type { ContextBundle } from "../context/engine";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import type { InteractionChain } from "../interaction/chain";
import { implementTddOp, implementerOp, testWriterOp, verifierOp, verifyTddOp, writeTddTestOp } from "../operations";
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
  /** Runtime for constructing CallContext when dispatching via callOp. */
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
 * Resolves per-role model tier, context inclusion, and isolation settings,
 * then delegates to runTddSession.
 */
export async function runTddSessionOp(
  op: TddSessionOp,
  options: TddSessionOpOptions,
  beforeRef: string,
  contextBundle?: ContextBundle,
  sessionBinding?: TddSessionBinding,
): Promise<TddSessionResult> {
  const {
    agent,
    agentManager,
    story,
    config,
    workdir,
    modelTier,
    featureName,
    contextMarkdown,
    featureContextMarkdown,
    constitution,
    lite = false,
    interactionChain,
    projectDir,
    abortSignal,
  } = options;

  const role = op.session.role as TddSessionRole;

  let tier: ModelTier;
  let includeContext: boolean;
  let skipIsolation: boolean;

  switch (role) {
    case "test-writer":
      tier = config.tdd.sessionTiers?.testWriter ?? "balanced";
      includeContext = true;
      skipIsolation = lite;
      break;
    case "implementer":
      tier = config.tdd.sessionTiers?.implementer ?? modelTier;
      includeContext = true;
      skipIsolation = lite;
      break;
    case "verifier":
      tier = config.tdd.sessionTiers?.verifier ?? "fast";
      includeContext = false;
      skipIsolation = false;
      break;
  }

  const interactionBridge = includeContext
    ? buildInteractionBridge(interactionChain, { featureName, storyId: story.id, stage: "execution" })
    : undefined;

  const verifierLimitedContext = role === "verifier";

  return runTddSession(
    role,
    agent,
    agentManager,
    story,
    config,
    workdir,
    tier,
    beforeRef,
    includeContext ? contextMarkdown : undefined,
    lite,
    skipIsolation,
    verifierLimitedContext ? undefined : constitution,
    featureName,
    interactionBridge,
    projectDir,
    includeContext ? featureContextMarkdown : undefined,
    verifierLimitedContext ? undefined : contextBundle,
    sessionBinding,
    abortSignal,
  );
}
