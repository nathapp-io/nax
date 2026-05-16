import { resolveDefaultAgent } from "../agents";
import type { IAgentManager } from "../agents";
import type { SessionHandle } from "../agents/types";
import type { ConfiguredModel, ModelDef } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { SessionRole } from "../session/types";
import type { ISessionManager } from "../session/types";
import {
  _debateSessionDeps,
  modelTierFromDebater,
  pipelineStageForDebate,
  resolveModelDefForDebater,
} from "./session-helpers";
import type { ResolvedDebater } from "./session-helpers";
import type { Debater } from "./types";

interface StatefulPlanOpts {
  workdir: string;
  feature: string;
  storyId: string;
  timeoutSeconds?: number;
}

export function resolveDebaterModelDef(debater: Debater, config: DebateConfig): ModelDef {
  const modelTier = modelTierFromDebater(debater);
  const model: ConfiguredModel = { agent: debater.agent, model: debater.model ?? modelTier };
  return resolveModelDefForDebater(debater, model, config.models, resolveDefaultAgent(config));
}

export async function openDebaterSessions(
  resolved: ResolvedDebater[],
  config: DebateConfig,
  sessionManager: ISessionManager,
  opts: StatefulPlanOpts,
  stage: string,
  abortSignal?: AbortSignal,
): Promise<Array<SessionHandle | null>> {
  const handles: Array<SessionHandle | null> = [];
  for (let i = 0; i < resolved.length; i++) {
    const { debater: rd, agentName } = resolved[i];
    const roleKey = `debate-plan-${i}` as SessionRole;
    const modelDef = resolveDebaterModelDef(rd, config);
    const name = sessionManager.nameFor({
      workdir: opts.workdir,
      featureName: opts.feature,
      storyId: opts.storyId,
      role: roleKey,
    });
    try {
      const handle = await sessionManager.openSession(name, {
        agentName,
        role: roleKey,
        workdir: opts.workdir,
        pipelineStage: pipelineStageForDebate(stage),
        modelDef,
        timeoutSeconds: opts.timeoutSeconds ?? 600,
        featureName: opts.feature,
        storyId: opts.storyId,
        signal: abortSignal,
      });
      handles.push(handle);
    } catch {
      handles.push(null);
    }
  }
  return handles;
}

export async function executeStatefulTurn(
  agentManager: IAgentManager,
  agentName: string,
  handle: SessionHandle,
  prompt: string,
  outputPath: string,
  storyId: string,
  stage: string,
): Promise<string> {
  await agentManager.runAsSession(agentName, handle, prompt, {
    storyId,
    pipelineStage: pipelineStageForDebate(stage),
  });
  return _debateSessionDeps.readFile(outputPath);
}

export async function executeStatefulRebuttal(
  agentManager: IAgentManager,
  agentName: string,
  handle: SessionHandle,
  prompt: string,
  outputPath: string,
  storyId: string,
  stage: string,
): Promise<string> {
  await agentManager.runAsSession(agentName, handle, prompt, {
    storyId,
    pipelineStage: pipelineStageForDebate(stage),
  });
  return _debateSessionDeps.readFile(outputPath);
}

export async function closeDebaterSessions(
  handles: Array<SessionHandle | null>,
  sessionManager: ISessionManager,
): Promise<void> {
  for (const handle of handles) {
    if (handle) {
      try {
        await sessionManager.closeSession(handle);
      } catch {
        // Ignore close errors
      }
    }
  }
}
