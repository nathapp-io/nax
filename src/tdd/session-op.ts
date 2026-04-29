/**
 * TDD ops are minimal role tags consumed by runTddSession (src/tdd/session-runner.ts),
 * not full Operation<I, O, C> shapes. See ADR-020 Wave 3 §Step 5 — verify/recover
 * hooks live on Operation, so TDD's session-side recovery (when needed) belongs
 * in the orchestrator, not here. Migration to true callOp ops is deferred per
 * ADR-018 §5.3 amendment.
 */
import type { AgentAdapter } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import type { ContextBundle } from "../context/engine";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import type { InteractionChain } from "../interaction/chain";
import type { UserStory } from "../prd";
import { runTddSession } from "./session-runner";
import type { TddSessionBinding } from "./session-runner";
import type { TddSessionResult, TddSessionRole } from "./types";

/** Typed config object identifying which TDD session role to run */
export interface TddRunOp {
  readonly role: TddSessionRole;
}

export const writeTddTestOp: TddRunOp = { role: "test-writer" };
export const implementTddOp: TddRunOp = { role: "implementer" };
export const verifyTddOp: TddRunOp = { role: "verifier" };

/** Subset of ThreeSessionTddOptions needed by runTddSessionOp */
export interface TddSessionOpOptions {
  agent: AgentAdapter;
  agentManager: import("../agents/manager-types").IAgentManager;
  story: UserStory;
  config: NaxConfig;
  workdir: string;
  modelTier: ModelTier;
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

/**
 * Run a single TDD session for the given op (role).
 * Resolves per-role model tier, context inclusion, and isolation settings,
 * then delegates directly to runTddSession.
 */
export async function runTddSessionOp(
  op: TddRunOp,
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

  const { role } = op;

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
    constitution,
    featureName,
    interactionBridge,
    projectDir,
    includeContext ? featureContextMarkdown : undefined,
    contextBundle,
    sessionBinding,
    abortSignal,
  );
}
