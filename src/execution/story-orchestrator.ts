/** StoryOrchestratorBuilder — fluent builder for ordered execution plans. */

import { agentManagerConfigSelector, resolveModelForAgent } from "../config";
import type { NaxConfig } from "../config";
import type { ConfigSelector } from "../config/selector";
import { NaxError } from "../errors";
import type { BuildContext, CallContext, RunOperation } from "../operations";
import { composeSections, join } from "../prompts/compose";

export interface OrchestratorSlot {
  readonly op: RunOperation<unknown, unknown, unknown>;
  readonly input: unknown;
  readonly runner?: (ctx: CallContext) => Promise<{ output: unknown; costUsd: number }>;
}

export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly phaseOutputs: Record<string, unknown>;
}

export interface ExecutionPlan {
  run(): Promise<StoryOrchestratorResult>;
}

export class StoryOrchestratorBuilder {
  private readonly _slots: OrchestratorSlot[] = [];
  private _hasImplementer = false;

  addTestWriter(slot: OrchestratorSlot): this {
    this._slots.push(slot);
    return this;
  }

  addImplementer(slot: OrchestratorSlot): this {
    this._hasImplementer = true;
    this._slots.push(slot);
    return this;
  }

  addVerifier(slot: OrchestratorSlot): this {
    this._slots.push(slot);
    return this;
  }

  addSemanticReview(slot: OrchestratorSlot): this {
    this._slots.push(slot);
    return this;
  }

  addAdversarialReview(slot: OrchestratorSlot): this {
    this._slots.push(slot);
    return this;
  }

  addRectification(): this {
    return this;
  }

  build(ctx: CallContext): ExecutionPlan {
    if (!this._hasImplementer) {
      throw new NaxError(
        "StoryOrchestratorBuilder.build(): addImplementer() must be called before build()",
        "ORCHESTRATOR_NO_IMPLEMENTER",
        { stage: "execution" },
      );
    }
    return new ConcreteExecutionPlan(ctx, [...this._slots]);
  }
}

function resolveOpConfig(op: RunOperation<unknown, unknown, unknown>, fullConfig: NaxConfig): unknown {
  if (Array.isArray(op.config)) {
    const keys = op.config as readonly (keyof NaxConfig)[];
    const slice: Record<string, unknown> = {};
    for (const key of keys) {
      slice[key] = fullConfig[key];
    }
    return slice;
  }
  return (op.config as ConfigSelector<unknown>).select(fullConfig);
}

class ConcreteExecutionPlan implements ExecutionPlan {
  constructor(
    private readonly ctx: CallContext,
    private readonly slots: readonly OrchestratorSlot[],
  ) {}

  async run(): Promise<StoryOrchestratorResult> {
    const start = Date.now();
    const phaseCosts: Record<string, number> = {};
    const phaseOutputs: Record<string, unknown> = {};
    let success = true;

    for (const slot of this.slots) {
      try {
        const { output, costUsd } = await this._runPhase(slot);
        phaseCosts[slot.op.name] = costUsd;
        phaseOutputs[slot.op.name] = output;
      } catch {
        success = false;
        phaseCosts[slot.op.name] = 0;
      }
    }

    const totalCostUsd = Object.values(phaseCosts).reduce((sum, c) => sum + c, 0);
    const durationMs = Date.now() - start;

    return { success, phaseCosts, totalCostUsd, durationMs, phaseOutputs };
  }

  private async _runPhase(slot: OrchestratorSlot): Promise<{ output: unknown; costUsd: number }> {
    if (slot.runner) {
      return slot.runner(this.ctx);
    }

    const fullConfig = this.ctx.packageView.config;
    const opConfig = resolveOpConfig(slot.op, fullConfig);
    const buildCtx: BuildContext<unknown> = { packageView: this.ctx.packageView, config: opConfig };

    const composeInput = slot.op.build(slot.input, buildCtx);
    const prompt = join(composeSections(composeInput));

    const agentName = this.ctx.agentName;
    const modelDef = resolveModelForAgent(fullConfig.models, agentName, "balanced", agentName);
    const agentManagerConfig = agentManagerConfigSelector.select(fullConfig);

    const outcome = await this.ctx.runtime.agentManager.runWithFallback({
      runOptions: {
        prompt,
        workdir: this.ctx.packageDir,
        modelTier: "balanced",
        modelDef,
        timeoutSeconds: fullConfig.execution?.sessionTimeoutSeconds ?? 300,
        config: agentManagerConfig,
      },
    });

    const rawOutput = outcome.result.output ?? "";
    const parsed = slot.op.parse(rawOutput, slot.input, buildCtx);
    const costUsd = outcome.result.estimatedCostUsd ?? 0;

    return { output: parsed, costUsd };
  }
}
