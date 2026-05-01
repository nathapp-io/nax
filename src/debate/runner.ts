import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG } from "../config";
import type { CompleteConfig, DebateConfig } from "../config/selectors";
import { callOp } from "../operations/call";
import { debateProposeOp } from "../operations/debate-propose";
import { debateRebutOp } from "../operations/debate-rebut";
import type { CallContext } from "../operations/types";
import type { ISessionManager } from "../session/types";
import { allSettledBounded } from "./concurrency";
import { buildDebaterLabel, resolvePersonas } from "./personas";
import { runHybrid } from "./runner-hybrid";
import { runPlan } from "./runner-plan";
import { runStateful } from "./runner-stateful";
import {
  type ResolveOutcome,
  type ResolvedDebater,
  type ResolverContextInput,
  type SuccessfulProposal,
  _debateSessionDeps,
  buildFailedResult,
  resolveOutcome,
} from "./session-helpers";
import type { DebateResult, DebateStageConfig, Proposal } from "./types";

const DEFAULT_TIMEOUT_SECONDS = 600;

export interface DebateRunnerOptions {
  readonly ctx: CallContext;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config?: NaxConfig;
  readonly workdir?: string;
  readonly featureName?: string;
  readonly timeoutSeconds?: number;
  readonly sessionManager?: ISessionManager;
  readonly reviewerSession?: import("../review/dialogue").ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
}

export class DebateRunner {
  private readonly ctx: CallContext;
  private readonly stage: string;
  private readonly stageConfig: DebateStageConfig;
  private readonly config: DebateConfig;
  /** TODO(#853): remove when CompleteOptions.config is eliminated at the manager boundary. */
  private readonly completeConfig: CompleteConfig | undefined;
  private readonly workdir: string;
  private readonly featureName: string;
  private readonly timeoutSeconds: number;
  private readonly sessionManager: ISessionManager | undefined;
  private readonly reviewerSession: DebateRunnerOptions["reviewerSession"];
  private readonly resolverContextInput: DebateRunnerOptions["resolverContextInput"];

  constructor(opts: DebateRunnerOptions) {
    this.ctx = opts.ctx;
    this.stage = opts.stage;
    this.stageConfig = opts.stageConfig;
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.completeConfig = opts.config;
    this.workdir = opts.workdir ?? opts.ctx.packageDir;
    this.featureName = opts.featureName ?? opts.stage;
    this.timeoutSeconds = opts.timeoutSeconds ?? opts.stageConfig.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.sessionManager = opts.sessionManager ?? opts.ctx.runtime?.sessionManager;
    this.reviewerSession = opts.reviewerSession;
    this.resolverContextInput = opts.resolverContextInput;
  }

  async run(prompt: string): Promise<DebateResult> {
    const sessionMode = this.stageConfig.sessionMode ?? "one-shot";
    const mode = this.stageConfig.mode ?? "panel";

    if (mode === "hybrid") {
      if (sessionMode === "stateful") {
        return runHybrid(this.toStatefulCtx(), prompt);
      }
      const logger = _debateSessionDeps.getSafeLogger();
      logger?.warn(
        "debate",
        `hybrid mode requires sessionMode: stateful, but got '${sessionMode}' — falling back to one-shot`,
      );
      return this.runPanelOneShot(prompt);
    }

    if (sessionMode === "stateful") {
      return runStateful(this.toStatefulCtx(), prompt);
    }

    return this.runPanelOneShot(prompt);
  }

  async runPlan(
    taskContext: string,
    outputFormat: string,
    opts: {
      workdir: string;
      feature: string;
      outputDir: string;
      timeoutSeconds?: number;
      maxInteractionTurns?: number;
      specContent?: string;
    },
  ): Promise<DebateResult> {
    return runPlan(this.toPlanCtx(), taskContext, outputFormat, opts);
  }

  private async runPanelOneShot(prompt: string): Promise<DebateResult> {
    const logger = _debateSessionDeps.getSafeLogger();
    const config = this.stageConfig;
    const personaStage: "plan" | "review" = this.stage === "plan" ? "plan" : "review";
    const rawDebaters = config.debaters ?? [];
    const debaters = resolvePersonas(rawDebaters, personaStage, config.autoPersona ?? false);
    let totalCostUsd = 0;

    const agentManager = this.ctx.runtime.agentManager;

    const resolved: ResolvedDebater[] = [];
    for (const debater of debaters) {
      if (!agentManager.getAgent(debater.agent)) {
        logger?.warn("debate", `Agent '${debater.agent}' not found — skipping debater`);
        continue;
      }
      resolved.push({ debater, agentName: debater.agent });
    }

    logger?.info("debate", "debate:start", {
      storyId: this.ctx.storyId,
      stage: this.stage,
      debaters: resolved.map((r) => r.debater.agent),
    });

    const concurrencyLimit =
      (this.config?.debate as { maxConcurrentDebaters?: number } | undefined)?.maxConcurrentDebaters ?? 2;

    const proposalSettled = await allSettledBounded(
      resolved.map(({ debater, agentName }, i) => () => {
        const debaterCtx: CallContext = { ...this.ctx, agentName };
        return callOp(debaterCtx, debateProposeOp, {
          taskContext: prompt,
          outputFormat: "",
          stage: this.stage,
          debaterIndex: i,
          debaters: resolved.map((r) => r.debater),
        }).then((output) => ({ debater, agentName, output, cost: 0 }) as SuccessfulProposal);
      }),
      concurrencyLimit,
    );

    const successful: SuccessfulProposal[] = proposalSettled
      .filter((r): r is PromiseFulfilledResult<SuccessfulProposal> => r.status === "fulfilled")
      .map((r) => r.value);

    for (let i = 0; i < successful.length; i++) {
      logger?.info("debate", "debate:proposal", {
        storyId: this.ctx.storyId,
        stage: this.stage,
        debaterIndex: i,
        agent: successful[i].debater.agent,
      });
    }

    if (successful.length < 2) {
      if (successful.length === 1) {
        logger?.warn("debate", "debate:fallback", {
          storyId: this.ctx.storyId,
          stage: this.stage,
          reason: "only 1 debater succeeded",
        });
        const solo = successful[0];
        logger?.info("debate", "debate:result", { storyId: this.ctx.storyId, stage: this.stage, outcome: "passed" });
        return {
          storyId: this.ctx.storyId ?? "",
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
        const { debater: fallbackDebater, agentName: fallbackAgentName } = resolved[0];
        logger?.warn("debate", "debate:fallback", {
          storyId: this.ctx.storyId,
          stage: this.stage,
          reason: "all debaters failed — retrying with first adapter",
        });
        try {
          const fallbackCtx: CallContext = { ...this.ctx, agentName: fallbackAgentName };
          const fallbackOutput = await callOp(fallbackCtx, debateProposeOp, {
            taskContext: prompt,
            outputFormat: "",
            stage: this.stage,
            debaterIndex: 0,
            debaters: [fallbackDebater],
          });
          logger?.info("debate", "debate:result", { storyId: this.ctx.storyId, stage: this.stage, outcome: "passed" });
          return {
            storyId: this.ctx.storyId ?? "",
            stage: this.stage,
            outcome: "passed",
            rounds: 1,
            debaters: [fallbackDebater.agent],
            resolverType: config.resolver.type,
            proposals: [{ debater: fallbackDebater, output: fallbackOutput }],
            totalCostUsd,
          };
        } catch {
          // Retry also failed — fall through
        }
      }

      return buildFailedResult(this.ctx.storyId ?? "", this.stage, config, totalCostUsd);
    }

    let critiqueOutputs: string[] = [];
    if (config.rounds > 1) {
      const proposals: Proposal[] = successful.map((p) => ({ debater: p.debater, output: p.output }));
      const critiqueSettled = await allSettledBounded(
        successful.map(({ debater, agentName }, i) => () => {
          const debaterCtx: CallContext = { ...this.ctx, agentName };
          return callOp(debaterCtx, debateRebutOp, {
            taskContext: prompt,
            stage: this.stage,
            debaterIndex: i,
            proposals,
            debaters: successful.map((s) => s.debater),
          });
        }),
        concurrencyLimit,
      );
      critiqueOutputs = critiqueSettled
        .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
        .map((r) => r.value);
    }

    const proposalOutputs = successful.map((p) => p.output);
    const fullResolverContext = this.resolverContextInput
      ? {
          ...this.resolverContextInput,
          labeledProposals: successful.map((s) => ({
            debater: buildDebaterLabel(s.debater),
            output: s.output,
          })),
        }
      : undefined;
    const outcome: ResolveOutcome = await resolveOutcome(
      proposalOutputs,
      critiqueOutputs,
      this.stageConfig,
      this.completeConfig,
      this.ctx.storyId ?? "",
      this.timeoutSeconds * 1000,
      this.workdir,
      this.featureName,
      this.reviewerSession,
      fullResolverContext,
      undefined,
      successful.map((s) => s.debater),
      agentManager,
    );
    totalCostUsd += outcome.resolverCostUsd;

    const proposals: Proposal[] = successful.map((p) => ({ debater: p.debater, output: p.output }));
    logger?.info("debate", "debate:result", { storyId: this.ctx.storyId, stage: this.stage, outcome: outcome.outcome });
    return {
      storyId: this.ctx.storyId ?? "",
      stage: this.stage,
      outcome: outcome.outcome,
      rounds: config.rounds,
      debaters: successful.map((s) => s.debater.agent),
      resolverType: config.resolver.type,
      proposals,
      totalCostUsd,
    };
  }

  private toStatefulCtx() {
    return {
      storyId: this.ctx.storyId ?? "",
      stage: this.stage,
      stageConfig: this.stageConfig,
      config: this.config,
      completeConfig: this.completeConfig,
      workdir: this.workdir,
      featureName: this.featureName,
      timeoutSeconds: this.timeoutSeconds,
      agentManager: this.ctx.runtime.agentManager,
      sessionManager: this.sessionManager ?? this.ctx.runtime.sessionManager,
      runtime: this.ctx.runtime,
      abortSignal: this.ctx.runtime.signal,
      reviewerSession: this.reviewerSession,
      resolverContextInput: this.resolverContextInput,
    };
  }

  private toPlanCtx() {
    return {
      storyId: this.ctx.storyId ?? "",
      stage: this.stage,
      stageConfig: this.stageConfig,
      config: this.config,
      completeConfig: this.completeConfig,
      agentManager: this.ctx.runtime.agentManager,
      sessionManager: this.sessionManager ?? this.ctx.runtime.sessionManager,
      runtime: this.ctx.runtime,
      abortSignal: this.ctx.runtime.signal,
    };
  }
}
