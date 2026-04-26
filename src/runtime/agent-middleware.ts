import type { AgentRunRequest } from "../agents/manager-types";
import type { NaxConfig } from "../config";
import type { ResolvedPermissions } from "../config/permissions";

export interface MiddlewareContext {
  readonly runId: string;
  readonly agentName: string;
  readonly kind: "run" | "complete" | "plan";
  readonly request: AgentRunRequest | null;
  readonly prompt: string | null;
  readonly config: NaxConfig;
  readonly signal?: AbortSignal;
  readonly resolvedPermissions: ResolvedPermissions;
  readonly storyId?: string;
  readonly stage?: string;
  /** Session handle when this is a caller-managed-session call (runAsSession). Absent for runAs/completeAs. */
  readonly sessionHandle?: import("../agents/types").SessionHandle;
}

export interface AgentMiddleware {
  readonly name: string;
  before?(ctx: MiddlewareContext): void | Promise<void>;
  after?(ctx: MiddlewareContext, result: unknown, durationMs: number): void | Promise<void>;
  onError?(ctx: MiddlewareContext, err: unknown, durationMs: number): void | Promise<void>;
}

export class MiddlewareChain {
  private constructor(private readonly _chain: readonly AgentMiddleware[]) {}

  static empty(): MiddlewareChain {
    return new MiddlewareChain([]);
  }

  static from(chain: readonly AgentMiddleware[]): MiddlewareChain {
    return new MiddlewareChain([...chain]);
  }

  async runBefore(ctx: MiddlewareContext): Promise<void> {
    for (const mw of this._chain) await mw.before?.(ctx);
  }

  async runAfter(ctx: MiddlewareContext, result: unknown, durationMs: number): Promise<void> {
    for (const mw of this._chain) await mw.after?.(ctx, result, durationMs);
  }

  async runOnError(ctx: MiddlewareContext, err: unknown, durationMs: number): Promise<void> {
    for (const mw of this._chain) await mw.onError?.(ctx, err, durationMs);
  }
}
