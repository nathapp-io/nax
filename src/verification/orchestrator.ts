// RE-ARCH: keep
/**
 * Verification Orchestrator (ADR-005, Phase 1)
 *
 * Single entry point for all test verification. Selects and delegates to the
 * appropriate strategy based on context. Additive — existing code paths are
 * unchanged until Phase 3.
 *
 * Usage:
 *   const result = await verificationOrchestrator.verify(ctx, "scoped");
 */

import type { IVerificationStrategy, VerifyContext, VerifyResult, VerifyStrategy } from "./orchestrator-types";
import { makeSkippedResult } from "./orchestrator-types";
import { AcceptanceStrategy } from "./strategies/acceptance";
import { DeferredRegressionStrategy, RegressionStrategy } from "./strategies/regression";
import { ScopedStrategy } from "./strategies/scoped";

export class VerificationOrchestrator {
  private readonly strategies: Map<VerifyStrategy, IVerificationStrategy>;

  constructor(overrides?: Partial<Record<VerifyStrategy, IVerificationStrategy>>) {
    this.strategies = new Map([
      ["scoped", overrides?.scoped ?? new ScopedStrategy()],
      ["regression", overrides?.regression ?? new RegressionStrategy()],
      ["deferred-regression", overrides?.["deferred-regression"] ?? new DeferredRegressionStrategy()],
      ["acceptance", overrides?.acceptance ?? new AcceptanceStrategy()],
    ]);
  }

  /**
   * Run verification using the specified strategy.
   *
   * @param ctx     - Context with workdir, testCommand, storyId, etc.
   * @param strategy - Which strategy to use
   * @returns Unified VerifyResult
   */
  async verify(ctx: VerifyContext, strategy: VerifyStrategy): Promise<VerifyResult> {
    const impl = this.strategies.get(strategy);
    if (!impl) {
      return makeSkippedResult(ctx.storyId, strategy);
    }
    return impl.execute(ctx);
  }

  /**
   * Run scoped verification (smart-runner selects test files).
   */
  async verifyScoped(ctx: VerifyContext): Promise<VerifyResult> {
    return this.verify(ctx, "scoped");
  }

  /**
   * Run full-suite regression gate.
   */
  async verifyRegression(ctx: VerifyContext): Promise<VerifyResult> {
    return this.verify(ctx, "regression");
  }

  /**
   * Run deferred regression gate (same as regression — caller decides timing).
   */
  async verifyDeferredRegression(ctx: VerifyContext): Promise<VerifyResult> {
    return this.verify(ctx, "deferred-regression");
  }

  /**
   * Run acceptance tests from feature directory.
   */
  async verifyAcceptance(ctx: VerifyContext): Promise<VerifyResult> {
    return this.verify(ctx, "acceptance");
  }
}

/** Singleton instance for production use. */
export const verificationOrchestrator = new VerificationOrchestrator();
