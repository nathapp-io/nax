/**
 * DebateSession
 *
 * Orchestrates a multi-agent debate for a single pipeline stage.
 * Resolves adapters, runs proposal and critique rounds, and calls the configured resolver.
 */

import { join } from "node:path";
import type { AcpClient, AcpSession, AcpSessionResponse } from "../agents/acp/adapter";
import { createSpawnAcpClient } from "../agents/acp/spawn-client";
import { estimateCostByDuration } from "../agents/cost/calculate";
import { createAgentRegistry, getAgent } from "../agents/registry";
import type { AgentAdapter, CompleteOptions, CompleteResult } from "../agents/types";
import type { ModelTier } from "../config";
import type { NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
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
  createSpawnAcpClient: (cmdStr: string, cwd?: string): AcpClient => createSpawnAcpClient(cmdStr, cwd),
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

function extractSessionOutput(response: AcpSessionResponse): string {
  const messages = response.messages ?? [];
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  return last?.content ?? "";
}

function modelTierFromDebater(debater: Debater): ModelTier {
  if (debater.model === "fast" || debater.model === "balanced" || debater.model === "powerful") {
    return debater.model;
  }
  return "fast";
}

async function runComplete(
  adapter: AgentAdapter,
  prompt: string,
  options: CompleteOptions,
  modelTier: ModelTier,
): Promise<CompleteResult> {
  return adapter.complete(prompt, {
    ...options,
    modelTier,
  });
}

function sessionResponseCostUsd(response: AcpSessionResponse, modelTier: ModelTier, durationMs: number): number {
  if (response.exactCostUsd !== undefined) {
    return response.exactCostUsd;
  }

  const estimate = estimateCostByDuration(modelTier, durationMs);
  return estimate.cost;
}

export class DebateSession {
  private readonly storyId: string;
  private readonly stage: string;
  private readonly stageConfig: DebateStageConfig;
  private readonly config: NaxConfig | undefined;

  constructor(opts: DebateSessionOptions) {
    this.storyId = opts.storyId;
    this.stage = opts.stage;
    this.stageConfig = opts.stageConfig;
    this.config = opts.config;
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

    interface SessionEntry {
      debater: Debater;
      adapter: AgentAdapter;
      session: AcpSession;
    }

    const sessions: SessionEntry[] = [];

    try {
      // Create SpawnAcpClient and session per debater
      for (let i = 0; i < resolved.length; i++) {
        const { debater, adapter } = resolved[i];
        const resolvedModel = resolveDebaterModel(debater, this.config);
        const cmdStr = resolvedModel ? `acpx --model ${resolvedModel} ${debater.agent}` : `acpx ${debater.agent}`;
        const client = _debateSessionDeps.createSpawnAcpClient(cmdStr);
        const sessionName = `nax-debate-${this.storyId}-${i}`;

        try {
          const session = await client.createSession({
            agentName: debater.agent,
            permissionMode: "approve-reads",
            sessionName,
          });
          sessions.push({ debater, adapter, session });
        } catch {
          logger?.warn("debate", `Failed to create session for '${debater.agent}' — skipping`);
        }
      }

      // Fewer than 2 sessions created
      if (sessions.length < 2) {
        // Single-agent fallback — run the one successful session as solo
        if (sessions.length === 1) {
          logger?.warn("debate", "debate:fallback", {
            storyId: this.storyId,
            stage: this.stage,
            reason: "only 1 session created",
          });
          const solo = sessions[0];
          const soloStart = Date.now();
          const response = await solo.session.prompt(prompt);
          totalCostUsd += sessionResponseCostUsd(response, modelTierFromDebater(solo.debater), Date.now() - soloStart);
          const output = extractSessionOutput(response);
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
            proposals: [{ debater: solo.debater, output }],
            totalCostUsd,
          };
        }
        logger?.warn("debate", "debate:fallback", {
          storyId: this.storyId,
          stage: this.stage,
          reason: "no sessions created",
        });
        return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
      }

      // Proposal round — parallel via Promise.allSettled
      const proposalSettled = await Promise.allSettled(
        sessions.map(async (entry) => {
          const startTime = Date.now();
          const response = await entry.session.prompt(prompt);
          return {
            entry,
            response,
            output: extractSessionOutput(response),
            cost: sessionResponseCostUsd(response, modelTierFromDebater(entry.debater), Date.now() - startTime),
          };
        }),
      );

      const successfulSessions: Array<{ entry: SessionEntry; output: string; cost: number; originalIndex: number }> =
        [];
      for (let i = 0; i < proposalSettled.length; i++) {
        const r = proposalSettled[i];
        if (r.status === "fulfilled") {
          successfulSessions.push({
            entry: r.value.entry,
            output: r.value.output,
            cost: r.value.cost,
            originalIndex: i,
          });
          totalCostUsd += r.value.cost;
        }
      }

      // AC5: minimum 2 debaters required for a valid debate
      if (successfulSessions.length < 2) {
        logger?.warn("debate", "debate:fallback", {
          storyId: this.storyId,
          stage: this.stage,
          reason: "fewer than 2 proposal rounds succeeded",
        });
        return buildFailedResult(this.storyId, this.stage, config, totalCostUsd);
      }

      for (let i = 0; i < successfulSessions.length; i++) {
        const s = successfulSessions[i];
        logger?.info("debate", "debate:proposal", {
          storyId: this.storyId,
          stage: this.stage,
          debaterIndex: i,
          agent: s.entry.debater.agent,
        });
      }

      // Critique round (when rounds > 1)
      // In stateful mode, send only OTHER debaters' proposals — session retains own history.
      // proposalOutputs is indexed by position within successfulSessions (dense, 0..N-1),
      // so we use successfulIdx (not originalIndex) when calling buildCritiquePrompt to
      // correctly exclude each debater's own proposal from the critique context.
      let critiqueOutputs: string[] = [];
      if (config.rounds > 1) {
        const proposalOutputs = successfulSessions.map((s) => s.output);
        const critiqueSettled = await Promise.allSettled(
          successfulSessions.map(async ({ entry }, successfulIdx) => {
            const startTime = Date.now();
            const response = await entry.session.prompt(buildCritiquePrompt(prompt, proposalOutputs, successfulIdx));
            return {
              output: extractSessionOutput(response),
              cost: sessionResponseCostUsd(response, modelTierFromDebater(entry.debater), Date.now() - startTime),
            };
          }),
        );
        critiqueOutputs = critiqueSettled
          .filter((r): r is PromiseFulfilledResult<{ output: string; cost: number }> => r.status === "fulfilled")
          .map((r) => {
            totalCostUsd += r.value.cost;
            return r.value.output;
          });
      }

      // Resolve outcome
      const proposalOutputs = successfulSessions.map((s) => s.output);
      const successfulProposals: SuccessfulProposal[] = successfulSessions.map((s) => ({
        debater: s.entry.debater,
        adapter: s.entry.adapter,
        output: s.output,
        cost: s.cost,
      }));
      const outcome = await this.resolve(proposalOutputs, critiqueOutputs, successfulProposals);
      totalCostUsd += outcome.resolverCostUsd;

      const proposals: Proposal[] = successfulSessions.map((s) => ({
        debater: s.entry.debater,
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
        debaters: successfulSessions.map((s) => s.entry.debater.agent),
        resolverType: config.resolver.type,
        proposals,
        totalCostUsd,
      };
    } finally {
      await Promise.allSettled(sessions.map(({ session }) => session.close()));
    }
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
      resolved.map(({ debater, adapter }) =>
        runComplete(
          adapter,
          prompt,
          {
            model: resolveDebaterModel(debater, this.config),
            featureName: this.stage,
            config: this.config,
            storyId: this.storyId,
            sessionRole: "debate-proposal",
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
              sessionRole: "debate-critique",
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

    // Run plan() for each debater in parallel, each writing to a unique temp path
    const planSettled = await Promise.allSettled(
      resolved.map(async ({ debater, adapter }, i) => {
        const tempOutputPath = join(opts.outputDir, `prd-debate-${i}.json`);
        // Append file-write instruction pointing at this debater's temp path
        const debaterPrompt = `${basePrompt}\n\nWrite the PRD JSON directly to this file path: ${tempOutputPath}\nDo NOT output the JSON to the conversation. Write the file, then reply with a brief confirmation.`;

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
          sessionRole: "plan",
        });

        const output = await _debateSessionDeps.readFile(tempOutputPath);
        return { debater, adapter, output, cost: 0 } as SuccessfulProposal;
      }),
    );

    const successful: SuccessfulProposal[] = planSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

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
