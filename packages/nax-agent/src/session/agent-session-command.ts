import { NaxError } from "#src/infra/nax-error";
import { displayToolInput, toolResultPreview } from "#src/native/session/turn-event-emitter";
import { _agentSessionDeps } from "./agent-session-deps.ts";
import type { ClaimedTurn, LiveTurn, TurnRunContext } from "./agent-session-turn.ts";
import type { CommandRunResult, SessionEvent, SessionEventBody } from "./agent-session-types.ts";
import type { OpenedBackend } from "./session-backend.ts";

interface CommandHooks {
  onStart(live: LiveTurn): void;
  onSettle(): void;
}

export interface ClaimedCommand extends Pick<ClaimedTurn, "turnId" | "settled" | "cancel"> {
  readonly result: Promise<CommandRunResult>;
}

/** Claim synchronously, but invoke callbacks only after the facade installs the claim. */
export function claimCommand(options: {
  ctx: TurnRunContext;
  run: NonNullable<OpenedBackend["runCommand"]>;
  command: string;
  onEvent(event: SessionEvent): void;
  hooks: CommandHooks;
}): ClaimedCommand {
  const { ctx, run, command, onEvent, hooks } = options;
  const turnId = _agentSessionDeps.randomUUID();
  const callId = _agentSessionDeps.randomUUID();
  const controller = new AbortController();
  const emit = (body: SessionEventBody): void =>
    onEvent({
      sessionId: ctx.sessionId,
      turnId,
      at: new Date(_agentSessionDeps.now()).toISOString(),
      metadata: ctx.metadata,
      ...body,
    });
  const abort = (code: string, reason: string): void =>
    controller.abort(new NaxError(reason, code, { stage: "agent-session" }));
  const result = Promise.resolve().then(async () => {
    const timer = _agentSessionDeps.setTimeout(
      () => abort("AGENT_SESSION_TURN_TIMEOUT", "turn deadline"),
      ctx.turnTimeoutSeconds * 1000,
    );
    try {
      hooks.onStart({ turnId, signal: controller.signal, emit });
      emit({ type: "tool_call", name: "Bash", input: displayToolInput({ command }), callId });
      const outcome = await run({ command, callId, signal: controller.signal });
      emit({ type: "tool_result", callId, isError: outcome.isError, preview: toolResultPreview(outcome.content) });
      return outcome;
    } finally {
      _agentSessionDeps.clearTimeout(timer);
      hooks.onSettle();
    }
  });
  return {
    turnId,
    result,
    settled: result.then(
      () => {},
      () => {},
    ),
    cancel: (reason) => abort("AGENT_SESSION_CANCELLED", reason),
  };
}
