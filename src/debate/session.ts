/**
 * DebateSession
 *
 * Orchestrates a multi-agent debate for a single pipeline stage.
 * Resolves adapters, runs proposal and critique rounds, and calls the configured resolver.
 */

import { join } from "node:path";
import { createAgentRegistry, getAgent } from "../agents/registry";
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../agents/types";
import type { ModelTier } from "../config";
import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG, resolveModel, resolveModelForAgent } from "../config";
import { resolvePermissions } from "../config/permissions";
import { getSafeLogger } from "../logger";
import { buildCritiquePrompt } from "./prompts";
import { judgeResolver, majorityResolver, synthesisResolver } from "./resolvers";
import type { DebateResult, DebateStageConfig, Debater, Proposal } from "./types";

/** Fallback agent name used when resolver.agent is not specified for synthesis/judge */
const RESOLVER_FALLBACK_AGENT = "synthesis";

/**
 * Resolve the model string for a debater.
 * When debater.model is set, treat it as a tier name and resolve via config.models.
 * When absent, default to "fast" tier.
 * Falls back to the raw debater.model string if config resolution fails (backward compat).
 */
export function resolveDebaterModel(debater: Debater, config?: NaxConfig): string | undefined {
  const tier = debater.model ?? "fast";
  if (!config?.models) return debater.model;
  try {
    const defaultAgent = config.autoMode?.defaultAgent ?? debater.agent;
    const modelDef = resolveModelForAgent(config.models, debater.agent, tier, defaultAgent);
    return modelDef.model;
  } catch {
    // Config resolution failed — return raw model string as fallback (backward compat)
    return debater.model;
  }
}

export interface DebateSessionOptions {
  storyId: string;
  stage: string;
  stageConfig: DebateStageConfig;
  config?: NaxConfig;
  workdir?: string;
  featureName?: string;
  timeoutSeconds?: number;
}

/** Injectable deps for testability */
export const _debateSessionDeps = {
  /**
   * Resolve an agent adapter by name.
   * When config is provided, uses createAgentRegistry(config) so that ACP agents
   * are returned as AcpAgentAdapter (respecting agent.protocol).
   * Falls back to bare getAgent() when config is absent (backward compat / tests).
   */
  getAgent: (name: string, config?: NaxConfig): AgentAdapter | undefined =>
    config ? createAgentRegistry(config).getAgent(name) : getAgent(name),
  getSafeLogger: getSafeLogger as () => ReturnType<typeof getSafeLogger>,
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
};

interface ResolvedDebater {
  debater: Debater;
  adapter: AgentAdapter;
}

interface SuccessfulProposal {
  debater: Debater;
  adapter: AgentAdapter;
  output: string;
  /** Cost for this complete() call in USD. */
  cost: number;
  roleKey?: string;
}

interface ResolveOutcome {
  outcome: "passed" | "failed" | "skipped";
  resolverCostUsd: number;
}

function buildFailedResult(
  storyId: string,
  stage: string,
  stageConfig: DebateStageConfig,
  totalCostUsd = 0,
): DebateResult {
  return {
    storyId,
    stage,
    outcome: "failed",
    rounds: 0,
    debaters: [],
    resolverType: stageConfig.resolver.type,
    proposals: [],
    totalCostUsd,
  };
}

function modelTierFromDebater(debater: Debater): ModelTier {
  if (debater.model === "fast" || debater.model === "balanced" || debater.model === "powerful") {
    return debater.model;
  }
  return "fast";
}

function isTierLabel(value: string): value is ModelTier {
  return value === "fast" || value === "balanced" || value === "powerful";
}

async function runComplete(
  adapter: AgentAdapter,
  prompt: string,
  options: CompleteOptions,
  modelTier: ModelTier,
  timeoutMs?: number,
): Promise<CompleteResult> {
  return adapter.complete(prompt, {
    ...options,
    modelTier,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
}

const DEFAULT_TIMEOUT_SECONDS = 600;

export class DebateSession {
  private readonly storyId: string;
  private readonly stage: string;
  private readonly stageConfig: DebateStageConfig;
  private readonly config: NaxConfig | undefined;
  private readonly workdir: string;
  private readonly featureName: string;
  private readonly timeoutSeconds: number;
  private get timeoutMs(): number {
    return this.timeoutSeconds * 1000;
  }

  constructor(opts: DebateSessionOptions) {
    this.storyId = opts.storyId;
    this.stage = opts.stage;
    this.stageConfig = opts.stageConfig;
    this.config = opts.config;
    this.workdir = opts.workdir ?? process.cwd();
    this.featureName = opts.featureName ?? opts.stage;
    this.timeoutSeconds = opts.timeoutSeconds ?? opts.stageConfig.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  private pipelineStageForDebate(): import("../config/permissions").PipelineStage {
    switch (this.stage) {
      case "plan":
      case "review":
      case "rectification":
      case "acceptance":
        return this.stage;
      default:
        return "run";
    }
  }

  private resolveModelDefForDebater(debater: Debater, tier: ModelTier) {
    if (debater.model && !isTierLabel(debater.model)) {
      return resolveModel(debater.model);
    }

    const configModels = this.config?.models ?? DEFAULT_CONFIG.models;
    const configDefaultAgent = this.config?.autoMode?.defaultAgent ?? DEFAULT_CONFIG.autoMode.defaultAgent;

    try {
      return resolveModelForAgent(configModels, debater.agent, tier, configDefaultAgent);
    } catch {
      // Fall through to secondary fallback strategies.
    }

    try {
      return resolveModelForAgent(
        DEFAULT_CONFIG.models,
        DEFAULT_CONFIG.autoMode.defaultAgent,
        tier,
        DEFAULT_CONFIG.autoMode.defaultAgent,
      );
    } catch {
      return resolveModelForAgent(configModels, debater.agent, "fast", configDefaultAgent);
    }
  }

  private async runStatefulTurn(
    adapter: AgentAdapter,
    debater: Debater,
    prompt: string,
    roleKey: string,
    keepSessionOpen: boolean,
  ): Promise<SuccessfulProposal> {
    const modelTier = modelTierFromDebater(debater);
    const modelDef = this.resolveModelDefForDebater(debater, modelTier);
    const pipelineStage = this.pipelineStageForDebate();

    const runResult = await adapter.run({
      prompt,
      workdir: this.workdir,
      modelTier,
      modelDef,
      timeoutSeconds: this.timeoutSeconds,
      dangerouslySkipPermissions: resolvePermissions(this.config, pipelineStage).skipPermissions,
      pipelineStage,
      config: this.config,
      featureName: this.featureName,
      storyId: this.storyId,
      sessionRole: roleKey,
      maxInteractionTurns: this.config?.agent?.maxInteractionTurns,
      keepSessionOpen,
    });

    if (!runResult.success) {
      throw new Error(runResult.output || `Stateful debate turn failed for ${debater.agent}`);
    }

    return {
      debater,
      adapter,
      output: runResult.output,
      cost: runResult.estimatedCost,
      roleKey,
    };
  }

  private async closeStatefulSession(adapter: AgentAdapter, debater: Debater, roleKey: string): Promise<number> {
    const modelTier = modelTierFromDebater(debater);
    const modelDef = this.resolveModelDefForDebater(debater, modelTier);
    const pipelineStage = this.pipelineStageForDebate();

    const runResult = await adapter.run({
      prompt: "Close this debate session.",
      workdir: this.workdir,
      modelTier,
      modelDef,
      timeoutSeconds: this.timeoutSeconds,
      dangerouslySkipPermissions: resolvePermissions(this.config, pipelineStage).skipPermissions,
      pipelineStage,
      config: this.config,
      featureName: this.featureName,
      storyId: this.storyId,
      sessionRole: roleKey,
      maxInteractionTurns: this.config?.agent?.maxInteractionTurns,
      keepSessionOpen: false,
    });

    return runResult.success ? runResult.estimatedCost : 0;
  }

  async run(prompt: string): Promise<DebateResult> {
    const sessionMode = this.stageConfig.sessionMode ?? "one-shot";

    if (sessionMode === "stateful") {
      return this.runStateful(prompt);
    }

    return this.runOneShot(prompt);
  }

  private async runStateful(prompt: string): Promise<DebateResult> {
    const logger = _debateSessionDeps.getSafeLogger();
    const config = this.stageConfig;
    const debaters = config.debaters ?? [];
    let totalCostUsd = 0;

    // Resolve adapters — skip unavailable agents
    const resolved: ResolvedDebater[] = [];
    for (const debater of debaters) {
      const adapter = _debateSessionDeps.getAgent(debater.agent, this.config);
      if (!adapter) {
        logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
        continue;
      }
      resolved.push({ debater, adapter });
    }

    logger?.info("debate", "debate:start", {
      storyId: this.storyId,
      stage: this.stage,
      debaters: resolved.map((r) => r.debater.agent),
    });

    // Proposal round — parallel via Promise.allSettled
    const proposalSettled = await Promise.allSettled(
      resolved.map(({ debater, adapter }, debaterIdx) =>
        this.runStatefulTurn(adapter, debater, prompt, `debate-${this.stage}-${debaterIdx}`, config.rounds > 1),
      ),
    );

    const successfulProposals: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    for (const r of proposalSettled) {
      if (r.status === "fulfilled") {
        totalCostUsd += r.value.cost;
      }
    }

    // Fewer than 2 succeeded — single-agent fallback for resiliency.
    if (successfulProposals.length < 2) {
      if (successfulProposals.length === 1) {
        const solo = successfulProposals[0];
        if (config.rounds > 1 && solo.roleKey) {
          totalCostUsd += await this.closeStatefulSession(solo.adapter, solo.debater, solo.roleKey);
        }
        logger?.warn("debate", "debate:fallback", {
          storyId: this.storyId,
          stage: this.stage,
          reason: "only 1 debater succeeded",
        });
        logger?.info("debate", "debate:result", {
          storyId: this.storyId,
          stage: this.stage,
          outcome: "passed",
        });
        return {
          storyId: this.storyId,
          stage: this.stage,
          outcome: "passed",
          rounds: 1,
          debaters: [solo.debater.agent],
          resolverType: config.resolver.type,
          proposals: [{ debater: solo.debater, output: solo.output }],
          totalCostUsd,
        };
      }

      if (resolved.length > 0) {
        const { adapter: fallbackAdapter, debater: fallbackDebater } = resolved[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: this.storyId,
          stage: this.stage,
          reason: "all debaters failed — retrying with first adapter",
        });
        try {
          const fallbackResult = await this.runStatefulTurn(
            fallbackAdapter,
            fallbackDebater,
            prompt,
            `debate-${this.stage}-fallback`,
            false,
          );
          totalCostUsd += fallbackResult.cost;
          logger?.info("debate", "debate:result", {
            storyId: this.storyId,
            stage: this.stage,
            outcome: "passed",
          });
          return {
            storyId: this.storyId,
            stage: this.stage,
            outcome: "passed",
            rounds: 1,
            debaters: [fallbackDebater.agent],
            resolverType: config.resolver.type,
            proposals: [{ debater: fallbackDebater, output: fallbackResult.output }],
            totalCostUsd,
          };
        } catch {
          // Retry also failed — fall through to failed result.
        }
      }

      logger?.warn("debate", "debate:fallback", {
        storyId: this.storyId,
        stage: this.stage,
        reason: "fewer than 2 proposal rounds succeeded",
      });
      return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
    }

    for (let i = 0; i < successfulProposals.length; i++) {
      const s = successfulProposals[i];
      logger?.info("debate", "debate:proposal", {
        storyId: this.storyId,
        stage: this.stage,
        debaterIndex: i,
        agent: s.debater.agent,
      });
    }

    // Critique round (when rounds > 1)
    // In stateful mode, send only OTHER debaters' proposals — session retains own history.
    // proposalOutputs is indexed by position within successfulProposals (dense, 0..N-1),
    // so we use successfulIdx when calling buildCritiquePrompt to correctly exclude
    // each debater's own proposal from the critique context.
    let critiqueOutputs: string[] = [];
    if (config.rounds > 1) {
      const proposalOutputs = successfulProposals.map((s) => s.output);
      const critiqueSettled = await Promise.allSettled(
        successfulProposals.map((proposal, successfulIdx) =>
          this.runStatefulTurn(
            proposal.adapter,
            proposal.debater,
            buildCritiquePrompt(prompt, proposalOutputs, successfulIdx),
            proposal.roleKey ?? `debate-${this.stage}-${successfulIdx}`,
            false,
          ),
        ),
      );

      for (const r of critiqueSettled) {
        if (r.status === "fulfilled") {
          totalCostUsd += r.value.cost;
        }
      }

      critiqueOutputs = critiqueSettled
        .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
        .map((r) => r.value.output);
    }

    // Resolve outcome
    const proposalOutputs = successfulProposals.map((s) => s.output);
    const outcome = await this.resolve(proposalOutputs, critiqueOutputs, successfulProposals);
    totalCostUsd += outcome.resolverCostUsd;

    const proposals: Proposal[] = successfulProposals.map((s) => ({
      debater: s.debater,
      output: s.output,
    }));

    logger?.info("debate", "debate:result", {
      storyId: this.storyId,
      stage: this.stage,
      outcome: outcome.outcome,
    });
    return {
      storyId: this.storyId,
      stage: this.stage,
      outcome: outcome.outcome,
      rounds: config.rounds,
      debaters: successfulProposals.map((s) => s.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      totalCostUsd,
    };
  }

  private async runOneShot(prompt: string): Promise<DebateResult> {
    const logger = _debateSessionDeps.getSafeLogger();
    const config = this.stageConfig;
    const debaters = config.debaters ?? [];
    let totalCostUsd = 0;

    // Step 1: Resolve adapters — skip unavailable agents
    const resolved: ResolvedDebater[] = [];
    for (const debater of debaters) {
      const adapter = _debateSessionDeps.getAgent(debater.agent, this.config);
      if (!adapter) {
        logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
        continue;
      }
      resolved.push({ debater, adapter });
    }

    logger?.info("debate", "debate:start", {
      storyId: this.storyId,
      stage: this.stage,
      debaters: resolved.map((r) => r.debater.agent),
    });

    // Step 2: Proposal round — parallel via Promise.allSettled
    const proposalSettled = await Promise.allSettled(
      resolved.map(({ debater, adapter }, i) =>
        runComplete(
          adapter,
          prompt,
          {
            model: resolveDebaterModel(debater, this.config),
            featureName: this.stage,
            config: this.config,
            storyId: this.storyId,
            sessionRole: `debate-proposal-${i}`,
            timeoutMs: this.timeoutMs,
          },
          modelTierFromDebater(debater),
        ).then((result) => ({ debater, adapter, output: result.output, cost: result.costUsd })),
      ),
    );

    const successful: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    // Accumulate proposal round costs
    for (const r of proposalSettled) {
      if (r.status === "fulfilled") {
        totalCostUsd += r.value.cost;
      }
    }

    for (let i = 0; i < successful.length; i++) {
      logger?.info("debate", "debate:proposal", {
        storyId: this.storyId,
        stage: this.stage,
        debaterIndex: i,
        agent: successful[i].debater.agent,
        model: resolveDebaterModel(successful[i].debater, this.config),
      });
    }

    // Step 3: Fewer than 2 succeeded — single-agent fallback
    if (successful.length < 2) {
      if (successful.length === 1) {
        logger?.warn("debate", "debate:fallback", {
          storyId: this.storyId,
          stage: this.stage,
          reason: "only 1 debater succeeded",
        });
        const solo = successful[0];
        logger?.info("debate", "debate:result", {
          storyId: this.storyId,
          stage: this.stage,
          outcome: "passed",
        });
        return {
          storyId: this.storyId,
          stage: this.stage,
          outcome: "passed",
          rounds: 1,
          debaters: [solo.debater.agent],
          resolverType: config.resolver.type,
          proposals: [{ debater: solo.debater, output: solo.output }],
          totalCostUsd,
        };
      }

      // All debaters failed — attempt fresh complete() on first resolved adapter (AC4)
      if (resolved.length > 0) {
        const { adapter: fallbackAdapter, debater: fallbackDebater } = resolved[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: this.storyId,
          stage: this.stage,
          reason: "all debaters failed — retrying with first adapter",
        });
        try {
          const fallbackResult = await runComplete(
            fallbackAdapter,
            prompt,
            {
              model: resolveDebaterModel(fallbackDebater, this.config),
              featureName: this.stage,
              config: this.config,
              storyId: this.storyId,
              sessionRole: "debate-fallback",
              timeoutMs: this.timeoutMs,
            },
            modelTierFromDebater(fallbackDebater),
          );
          totalCostUsd += fallbackResult.costUsd;
          logger?.info("debate", "debate:result", {
            storyId: this.storyId,
            stage: this.stage,
            outcome: "passed",
          });
          return {
            storyId: this.storyId,
            stage: this.stage,
            outcome: "passed",
            rounds: 1,
            debaters: [fallbackDebater.agent],
            resolverType: config.resolver.type,
            proposals: [{ debater: fallbackDebater, output: fallbackResult.output }],
            totalCostUsd,
          };
        } catch {
          // Fallback also failed — fall through to buildFailedResult
        }
      }

      return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
    }

    // Step 4: Critique rounds (when rounds > 1)
    let critiqueOutputs: string[] = [];
    if (config.rounds > 1) {
      const proposalOutputs = successful.map((p) => p.output);
      const critiqueSettled = await Promise.allSettled(
        successful.map(({ debater, adapter }, i) =>
          runComplete(
            adapter,
            buildCritiquePrompt(prompt, proposalOutputs, i),
            {
              model: resolveDebaterModel(debater, this.config),
              featureName: this.stage,
              config: this.config,
              storyId: this.storyId,
              sessionRole: `debate-critique-${i}`,
              timeoutMs: this.timeoutMs,
            },
            modelTierFromDebater(debater),
          ),
        ),
      );
      for (const r of critiqueSettled) {
        if (r.status === "fulfilled") {
          totalCostUsd += r.value.costUsd;
        }
      }
      critiqueOutputs = critiqueSettled
        .filter((r): r is PromiseFulfilledResult<CompleteResult> => r.status === "fulfilled")
        .map((r) => r.value.output);
    }

    // Step 5: Resolve outcome
    const proposalOutputs = successful.map((p) => p.output);
    const outcome = await this.resolve(proposalOutputs, critiqueOutputs, successful);
    totalCostUsd += outcome.resolverCostUsd;

    const proposals: Proposal[] = successful.map((p) => ({
      debater: p.debater,
      output: p.output,
    }));

    logger?.info("debate", "debate:result", {
      storyId: this.storyId,
      stage: this.stage,
      outcome: outcome.outcome,
    });
    return {
      storyId: this.storyId,
      stage: this.stage,
      outcome: outcome.outcome,
      rounds: config.rounds,
      debaters: successful.map((p) => p.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      totalCostUsd,
    };
  }

  /**
   * Run a plan-mode debate.
   *
   * Each debater calls adapter.plan() writing its PRD to a unique temp path under outputDir.
   * After all plans complete, the resolver picks the best PRD (or synthesises one).
   * Returns a DebateResult whose `output` field contains the winning PRD JSON string.
   *
   * @param basePrompt - Planning prompt WITHOUT a file-write instruction (outputFilePath omitted).
   *                     runPlan() appends the per-debater temp file path instruction itself.
   * @param opts       - Plan options shared across all debaters.
   */
  async runPlan(
    basePrompt: string,
    opts: {
      workdir: string;
      feature: string;
      outputDir: string;
      timeoutSeconds?: number;
      dangerouslySkipPermissions?: boolean;
      maxInteractionTurns?: number;
    },
  ): Promise<DebateResult> {
    const logger = _debateSessionDeps.getSafeLogger();
    const config = this.stageConfig;
    const debaters = config.debaters ?? [];
    const totalCostUsd = 0;

    // Resolve adapters — skip unavailable agents
    const resolved: ResolvedDebater[] = [];
    for (const debater of debaters) {
      const adapter = _debateSessionDeps.getAgent(debater.agent, this.config);
      if (!adapter) {
        logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
        continue;
      }
      resolved.push({ debater, adapter });
    }

    logger?.info("debate", "debate:start", {
      storyId: this.storyId,
      stage: this.stage,
      debaters: resolved.map((r) => r.debater.agent),
    });

    // Run plan() turn-by-turn to avoid concurrent session races in ACP mode.
    const successful: SuccessfulProposal[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const { debater, adapter } = resolved[i];
      const tempOutputPath = join(opts.outputDir, `prd-debate-${i}.json`);
      const debaterPrompt = `${basePrompt}\n\nWrite the PRD JSON directly to this file path: ${tempOutputPath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`;

      try {
        await adapter.plan({
          prompt: debaterPrompt,
          workdir: opts.workdir,
          interactive: false,
          timeoutSeconds: opts.timeoutSeconds,
          config: this.config,
          modelTier: (debater.model ?? "balanced") as import("../config/schema-types").ModelTier,
          dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
          maxInteractionTurns: opts.maxInteractionTurns,
          featureName: opts.feature,
          storyId: this.storyId,
          sessionRole: `plan-${i}`,
        });

        const output = await _debateSessionDeps.readFile(tempOutputPath);
        successful.push({ debater, adapter, output, cost: 0 });
      } catch (err) {
        logger?.warn("debate", "debate:debater-failed", {
          storyId: this.storyId,
          stage: this.stage,
          debaterIndex: i,
          agent: debater.agent,
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep debate resilient: continue with remaining debaters when one fails.
      }
    }

    for (let i = 0; i < successful.length; i++) {
      logger?.info("debate", "debate:proposal", {
        storyId: this.storyId,
        stage: this.stage,
        debaterIndex: i,
        agent: successful[i].debater.agent,
      });
    }

    if (successful.length === 0) {
      logger?.warn("debate", "debate:fallback", {
        storyId: this.storyId,
        stage: this.stage,
        reason: "all plan debaters failed",
      });
      return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
    }

    // Single success — use directly (no resolver needed)
    if (successful.length === 1) {
      logger?.warn("debate", "debate:fallback", {
        storyId: this.storyId,
        stage: this.stage,
        reason: "only 1 plan debater succeeded — using as solo",
      });
      logger?.info("debate", "debate:result", { storyId: this.storyId, stage: this.stage, outcome: "passed" });
      return {
        storyId: this.storyId,
        stage: this.stage,
        outcome: "passed",
        rounds: 1,
        debaters: [successful[0].debater.agent],
        resolverType: config.resolver.type,
        proposals: [{ debater: successful[0].debater, output: successful[0].output }],
        output: successful[0].output,
        totalCostUsd,
      };
    }

    // Multiple proposals — resolve to pick the winning PRD
    const proposalOutputs = successful.map((p) => p.output);
    const outcome = await this.resolve(proposalOutputs, [], successful);

    // Winning output: synthesis resolver returns combined PRD via synthesisResolver output;
    // for majority/custom, use the first proposal as the baseline winner.
    // synthesisResolver currently does not return output — use first proposal for now.
    const winningOutput = successful[0].output;

    const proposals: Proposal[] = successful.map((p) => ({ debater: p.debater, output: p.output }));

    logger?.info("debate", "debate:result", { storyId: this.storyId, stage: this.stage, outcome });
    return {
      storyId: this.storyId,
      stage: this.stage,
      outcome: outcome.outcome,
      rounds: 1,
      debaters: successful.map((p) => p.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      output: winningOutput,
      totalCostUsd,
    };
  }

  private async resolve(
    proposalOutputs: string[],
    critiqueOutputs: string[],
    _successful: SuccessfulProposal[],
  ): Promise<ResolveOutcome> {
    const resolverConfig = this.stageConfig.resolver;

    if (resolverConfig.type === "majority-fail-closed" || resolverConfig.type === "majority-fail-open") {
      return {
        outcome: majorityResolver(proposalOutputs, resolverConfig.type === "majority-fail-open"),
        resolverCostUsd: 0,
      };
    }

    if (resolverConfig.type === "synthesis") {
      const agentName = resolverConfig.agent ?? RESOLVER_FALLBACK_AGENT;
      const adapter = _debateSessionDeps.getAgent(agentName, this.config);
      if (adapter) {
        const resolverResult = await synthesisResolver(proposalOutputs, critiqueOutputs, {
          adapter,
          completeOptions: {
            model: resolveDebaterModel({ agent: agentName }, this.config),
            config: this.config,
            storyId: this.storyId,
            sessionRole: "synthesis",
            timeoutMs: this.timeoutMs,
          },
        });
        return {
          outcome: "passed",
          resolverCostUsd: resolverResult.costUsd,
        };
      }
      return {
        outcome: "passed",
        resolverCostUsd: 0,
      };
    }

    if (resolverConfig.type === "custom") {
      const agentName = resolverConfig.agent ?? RESOLVER_FALLBACK_AGENT;
      const resolverResult = await judgeResolver(proposalOutputs, critiqueOutputs, resolverConfig, {
        getAgent: (name: string) => _debateSessionDeps.getAgent(name, this.config),
        defaultAgentName: RESOLVER_FALLBACK_AGENT,
        completeOptions: {
          model: resolveDebaterModel({ agent: agentName }, this.config),
          config: this.config,
          storyId: this.storyId,
          sessionRole: "judge",
          timeoutMs: this.timeoutMs,
        },
      });
      return {
        outcome: "passed",
        resolverCostUsd: resolverResult.costUsd,
      };
    }

    return {
      outcome: "passed",
      resolverCostUsd: 0,
    };
  }
}
