/**
 * SessionKeeper — session reuse + transport retry abstraction.
 *
 * Encapsulates the getLiveHandle → openSession → try/catch transport retry →
 * bindHandle pattern duplicated in rectification-loop.ts and rectification-runner.ts.
 */

import type { IAgentManager } from "../agents/manager-types";
import type { RetryStrategy } from "../agents/retry";
import type { SessionHandle, TurnResult } from "../agents/types";
import type { PipelineStage } from "../config/permissions";
import type { ModelDef } from "../config/schema";
import { getSafeLogger } from "../logger";
import type { ISessionManager, SessionRole } from "./types";

export interface SessionKeeperOptions {
  readonly sessionName: string;
  readonly defaultAgent: string;
  readonly role: SessionRole;
  readonly pipelineStage: PipelineStage;
  readonly storyId: string;
  readonly featureName?: string;
  readonly workdir: string;
  readonly projectDir?: string;
  readonly modelDef: ModelDef;
  readonly timeoutSeconds: number;
  /**
   * Transport retry policy for retryable SessionTurnErrors.
   * Callers build this from resolveRetryPreset({ preset: "transient-network",
   * maxAttempts: config.execution.sessionErrorRetryableMaxRetries + 1, baseDelayMs: 0 }).
   * Defaults to no retries when absent.
   */
  readonly retryStrategy?: RetryStrategy;
  readonly signal?: AbortSignal;
  readonly maxTurns?: number;
}

export interface SessionKeeperSendOptions {
  readonly prompt: string;
}

/**
 * Manages a single held session handle across multiple send() calls.
 * On each send: reuses an existing live handle (getLiveHandle) if present,
 * or opens a new one (openSession). On SessionTurnError with retryable=true,
 * discards the stale handle and delegates to the injected retryStrategy for
 * the retry decision. Call close() in a finally block to ensure the handle
 * is released.
 */
export class SessionKeeper {
  private heldHandle: SessionHandle | undefined;
  private retryAttempts = 0;

  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly agentManager: IAgentManager,
    private readonly opts: SessionKeeperOptions,
  ) {}

  /** Send one turn. Reuses or opens the held handle. Retries on retryable transport errors. */
  async send(sendOpts: SessionKeeperSendOptions): Promise<TurnResult> {
    const {
      sessionName,
      defaultAgent,
      role,
      pipelineStage,
      modelDef,
      timeoutSeconds,
      featureName,
      storyId,
      workdir,
      projectDir,
      signal,
      maxTurns,
      retryStrategy,
    } = this.opts;

    while (true) {
      if (!this.heldHandle) {
        const existing = await this.sessionManager.getLiveHandle?.(sessionName);
        if (existing && existing.agentName === defaultAgent) {
          this.heldHandle = existing;
        } else {
          this.heldHandle = await this.sessionManager.openSession(sessionName, {
            agentName: defaultAgent,
            role,
            workdir,
            pipelineStage,
            modelDef,
            timeoutSeconds,
            featureName,
            storyId,
            signal,
          });
        }
      }

      try {
        const turn = await this.agentManager.runAsSession(defaultAgent, this.heldHandle, sendOpts.prompt, {
          storyId,
          featureName,
          workdir,
          projectDir,
          pipelineStage,
          sessionRole: role,
          signal,
          maxTurns,
        });
        return turn;
      } catch (err) {
        const stale = this.heldHandle;
        this.heldHandle = undefined;
        await this.sessionManager.closeSession(stale).catch(() => {});

        const isRetryable = Boolean((err as { retryable?: unknown })?.retryable === true);
        if (isRetryable) {
          if (retryStrategy) {
            const decision = await retryStrategy.shouldRetry(err as Error, this.retryAttempts, {
              site: "run",
              agentName: defaultAgent,
              stage: pipelineStage,
              storyId,
            });
            if (decision.retry) {
              this.retryAttempts++;
              getSafeLogger()?.warn("session-keeper", "fail-adapter-error: same-agent retry with fresh session", {
                storyId,
                attempt: this.retryAttempts,
                retriable: true,
              });
              continue;
            }
          }
        }
        throw err;
      }
    }
  }

  /** Protocol IDs from the currently held session handle, if available. */
  get heldProtocolIds(): SessionHandle["protocolIds"] {
    return this.heldHandle?.protocolIds;
  }

  /**
   * Bind protocolIds from the last turn to the session descriptor for the audit trail.
   * Always uses heldHandle.id as the descriptor key — this is the canonical form.
   */
  bindProtocolIds(): void {
    if (!this.heldHandle?.protocolIds) return;
    try {
      this.sessionManager.bindHandle(this.heldHandle.id, this.opts.sessionName, this.heldHandle.protocolIds);
    } catch {
      // Session may not exist in manager (e.g. v2 context disabled) — ignore.
    }
  }

  /**
   * Bind protocolIds to an explicit target manager, if provided.
   * No-op when manager is undefined — callers use this to make bindHandle conditional
   * on whether the optional sessionManager parameter was supplied.
   */
  bindProtocolIdsTo(manager: ISessionManager | undefined): void {
    if (!manager || !this.heldHandle?.protocolIds) return;
    try {
      manager.bindHandle(this.heldHandle.id, this.opts.sessionName, this.heldHandle.protocolIds);
    } catch {
      // Session may not exist in manager (e.g. v2 context disabled) — ignore.
    }
  }

  /** Close the held handle (best-effort). Safe to call when no handle is open. */
  async close(): Promise<void> {
    if (!this.heldHandle) return;
    const stale = this.heldHandle;
    this.heldHandle = undefined;
    await this.sessionManager.closeSession(stale).catch(() => {});
  }
}
