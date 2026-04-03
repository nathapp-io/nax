import type { StoryLogger } from "../logger/types";

type LoopLogger = Pick<StoryLogger, "debug" | "error" | "info" | "warn"> | null;
type LoopLogData<State> = Record<string, unknown> | ((state: State) => Record<string, unknown>);

export interface ProgressivePromptPreambleOptions {
  attempt: number;
  maxAttempts: number;
  rethinkAtAttempt?: number;
  urgencyAtAttempt?: number;
  stage: string;
  logger?: LoopLogger;
  rethinkSection: string;
  urgencySection: string;
}

export interface SharedRectificationLoopOptions<State extends { attempt: number }> {
  stage: string;
  storyId: string;
  maxAttempts: number;
  state: State;
  logger?: LoopLogger;
  startMessage: string;
  startData?: LoopLogData<State>;
  attemptMessage: (attempt: number, maxAttempts: number, state: State) => string;
  attemptData?: LoopLogData<State>;
  canContinue: (state: State) => boolean;
  buildPrompt: (attempt: number, state: State) => Promise<string> | string;
  runAttempt: (attempt: number, prompt: string, state: State) => Promise<void>;
  checkResult: (attempt: number, state: State) => Promise<boolean>;
  onAttemptFailure?: (attempt: number, state: State) => Promise<void> | void;
  onLoopEnd?: (state: State) => Promise<void> | void;
  onExhausted?: (state: State) => Promise<boolean> | boolean;
}

function resolveLogData<State>(data: LoopLogData<State> | undefined, state: State): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }
  return typeof data === "function" ? data(state) : data;
}

export function buildProgressivePromptPreamble(opts: ProgressivePromptPreambleOptions): string {
  const rethinkAt = Math.min(opts.rethinkAtAttempt ?? 2, opts.maxAttempts);
  const urgencyAt = Math.min(opts.urgencyAtAttempt ?? 3, opts.maxAttempts);
  const shouldRethink = opts.attempt >= rethinkAt;
  const shouldUrgency = opts.attempt >= urgencyAt;

  if (!shouldRethink && !shouldUrgency) {
    return "";
  }

  if (shouldUrgency) {
    opts.logger?.info(opts.stage, "Progressive prompt escalation: urgency + rethink injected", {
      attempt: opts.attempt,
      rethinkAtAttempt: rethinkAt,
      urgencyAtAttempt: urgencyAt,
      maxAttempts: opts.maxAttempts,
    });
  } else {
    opts.logger?.info(opts.stage, "Progressive prompt escalation: rethink injected", {
      attempt: opts.attempt,
      rethinkAtAttempt: rethinkAt,
      maxAttempts: opts.maxAttempts,
    });
  }

  const urgencySection = shouldUrgency ? opts.urgencySection : "";
  const rethinkSection = shouldRethink ? opts.rethinkSection : "";
  return `${urgencySection}${rethinkSection}`;
}

export async function runSharedRectificationLoop<State extends { attempt: number }>(
  opts: SharedRectificationLoopOptions<State>,
): Promise<boolean> {
  opts.logger?.info(opts.stage, opts.startMessage, resolveLogData(opts.startData, opts.state));

  while (opts.canContinue(opts.state)) {
    opts.state.attempt++;

    opts.logger?.info(
      opts.stage,
      opts.attemptMessage(opts.state.attempt, opts.maxAttempts, opts.state),
      resolveLogData(opts.attemptData, opts.state),
    );

    const prompt = await opts.buildPrompt(opts.state.attempt, opts.state);
    await opts.runAttempt(opts.state.attempt, prompt, opts.state);

    const passed = await opts.checkResult(opts.state.attempt, opts.state);
    if (passed) {
      return true;
    }

    await opts.onAttemptFailure?.(opts.state.attempt, opts.state);
  }

  await opts.onLoopEnd?.(opts.state);

  if (opts.state.attempt >= opts.maxAttempts) {
    return (await opts.onExhausted?.(opts.state)) ?? false;
  }

  return false;
}
