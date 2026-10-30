/**
 * The chat model/mode switch as a state machine over injected open seams.
 *
 * Order of attempts: apply the change in place on the live session (ACP only), else close
 * and reopen the same session id on the target, else roll back by reopening the original,
 * else release the old session's lock and start a new chat session on the original target.
 * The host applies the returned outcome; nothing here touches host state.
 */
import type { SessionMeta } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { acpInPlaceChange } from "./acp";
import type { ChatMode } from "./chat-mode";
import type { ChatSessionHandle } from "./open-chat-session";

export interface SwitchTarget {
  readonly mode: ChatMode;
  readonly model: string;
}

export interface SwitchInput {
  /** The open handle being switched away from. */
  readonly previous: ChatSessionHandle;
  /** Its mode and model. */
  readonly from: SwitchTarget;
  /** The requested mode and model. */
  readonly target: SwitchTarget;
  /** Resume `previous.meta.sessionId` on `to`. */
  readonly reopen: (to: SwitchTarget) => Promise<ChatSessionHandle>;
  /** A new chat session, as `start` opens one. */
  readonly openFresh: (to: SwitchTarget) => Promise<ChatSessionHandle>;
  readonly writeMeta: (meta: SessionMeta) => Promise<void>;
}

export interface SwitchOutcome {
  readonly handle: ChatSessionHandle;
  /** The switch failure to rethrow after applying the outcome. */
  readonly error?: unknown;
  /** Set only when the outcome is a new session. */
  readonly notice?: string;
}

/** Shown when the rollback could not reopen the old session and a new one took its place. */
export const ROLLBACK_NEW_SESSION_NOTICE = (oldId: string, reason: string): string =>
  `could not reopen session ${oldId} after the failed switch (${reason}); started a new session (/resume ${oldId} retries it)`;

const LINE_BREAK = /\r\n|\r|\n/;

/** Configure the live session; any failure leaves it open for the reopen path. */
async function applyInPlace(input: SwitchInput): Promise<ChatSessionHandle | undefined> {
  const { previous, from, target } = input;
  if (target.mode !== from.mode) return undefined;
  const change = acpInPlaceChange(from.model, target.model);
  const configure = previous.session.configure;
  if (change === undefined || configure === undefined) return undefined;
  try {
    await configure.call(previous.session, change);
    const meta: SessionMeta = { ...previous.meta, model: target.model };
    await input.writeMeta(meta);
    return { ...previous, meta };
  } catch {
    // The agent refused, or the meta could not be written: the reopen applies the target
    // from scratch and writes the meta again, so the failure itself is not reported.
    return undefined;
  }
}

async function retire(handle: ChatSessionHandle): Promise<void> {
  try {
    await handle.session.close();
  } finally {
    await handle.release({ retainLock: true });
  }
}

/** Close the previous session and reopen it on `target`; the half-opened session is retired on failure. */
async function closeAndReopen(input: SwitchInput): Promise<ChatSessionHandle> {
  let next: ChatSessionHandle | undefined;
  try {
    await retire(input.previous);
    next = await input.reopen(input.target);
    await input.writeMeta(next.meta);
    return next;
  } catch (error) {
    if (next) await retire(next);
    throw error;
  }
}

/** The old session could not be reopened: free its lock and start a new session on the original target. */
async function startNewSession(input: SwitchInput, switchError: unknown): Promise<SwitchOutcome> {
  const oldId = input.previous.meta.sessionId;
  const reason = errorMessage(switchError).split(LINE_BREAK)[0] ?? "";
  try {
    await input.previous.release();
    const handle = await input.openFresh(input.from);
    return { handle, error: switchError, notice: ROLLBACK_NEW_SESSION_NOTICE(oldId, reason) };
  } catch (freshError) {
    const failure = new NaxError(
      `[chat] could not switch session ${oldId} (${errorMessage(switchError)}) and could not start a new session (${errorMessage(freshError)})`,
      "CHAT_SESSION_REOPEN_FAILED",
      { stage: "chat", sessionId: oldId, switchError: errorMessage(switchError), cause: freshError },
    );
    failure.cause = freshError;
    throw failure;
  }
}

export async function switchChatSession(input: SwitchInput): Promise<SwitchOutcome> {
  const inPlace = await applyInPlace(input);
  if (inPlace !== undefined) return { handle: inPlace };
  try {
    return { handle: await closeAndReopen(input) };
  } catch (error) {
    try {
      return { handle: await input.reopen(input.from), error };
    } catch {
      // The rollback failed too: the old session cannot be resumed, so recover onto a new one.
      return startNewSession(input, error);
    }
  }
}
