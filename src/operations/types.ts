import type { AgentResult } from "../agents/types";
import type { ConfigSelector } from "../config";
import type { NaxConfig } from "../config";
import type { PipelineStage } from "../config/permissions";
import type { ComposeInput } from "../prompts/compose";
import type { NaxRuntime, PackageView } from "../runtime";
import type { SessionRole } from "../session/types";

export interface BuildContext<C> {
  readonly packageView: PackageView;
  readonly config: C;
}

export interface CallContext {
  readonly runtime: NaxRuntime;
  readonly packageView: PackageView;
  readonly packageDir: string;
  readonly storyId?: string;
  readonly agentName: string;
  readonly sessionOverride?: {
    readonly role?: SessionRole;
    readonly discriminator?: string | number;
  };
}

interface OperationBase<I, O, C> {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly config: ConfigSelector<C> | readonly (keyof NaxConfig)[];
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  readonly parse: (output: string) => O;
}

export interface RunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "run";
  /** Reserved for future model-tier override; not yet consumed by callOp (Wave 3). */
  readonly mode?: string;
  readonly session: {
    readonly role: SessionRole;
    readonly lifetime: "fresh" | "warm";
  };
  readonly noFallback?: boolean;
}

export interface CompleteOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "complete";
  readonly jsonMode?: boolean;
}

export type Operation<I, O, C> = RunOperation<I, O, C> | CompleteOperation<I, O, C>;

export interface SessionRunnerContext {
  readonly runtime: NaxRuntime;
  readonly agentName: string;
  readonly packageDir: string;
  readonly storyId?: string;
  readonly prompt: string;
  readonly op: RunOperation<unknown, unknown, unknown>;
  readonly sessionOverride?: CallContext["sessionOverride"];
  readonly noFallback?: boolean;
}

export interface SessionRunnerOutcome {
  readonly primaryResult: AgentResult;
  readonly fallbacks: readonly AgentResult[];
}
