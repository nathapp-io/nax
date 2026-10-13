/** Per-turn work SessionManager runs around adapter.sendTurn: plugin loop handlers, and the afterTurn hook (#2497). */

import type { SessionHandle } from "@nathapp/nax-agent";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "../logger";
import {
  buildLoopHandlerTurnOpts,
  LOOP_HANDLERS_NATIVE_ONLY_MESSAGE,
  shouldLogNativeOnlyScope,
} from "./loop-handler-forwarding";
import type { SessionDescriptor } from "./types";

export type AfterTurnHook = (desc: SessionDescriptor, turn: number) => Promise<void>;

export class TurnHooks {
  private scopeLogged = false;
  private hook: ((desc: SessionDescriptor, turn: number) => Promise<void>) | undefined;
  private readonly turns = new Map<string, number>();

  setAfterTurn(hook: AfterTurnHook): void {
    this.hook = hook;
  }

  /** US-004: deliver the run's loop handlers; say once when a non-native session cannot use them. */
  loopHandlerOpts(handle: SessionHandle, descriptor: SessionDescriptor | undefined, set: LoopHandlerSet) {
    const opts = buildLoopHandlerTurnOpts({ handle, descriptor, set });
    if (shouldLogNativeOnlyScope(set, handle, this.scopeLogged)) {
      this.scopeLogged = true;
      getLogger().info("plugins", LOOP_HANDLERS_NATIVE_ONLY_MESSAGE, { sessionName: handle.id });
    }
    return opts;
  }

  /** Awaited in sendPrompt's finally; never throws, so the turn's own result or error wins. */
  async afterTurn(desc: SessionDescriptor | undefined, sessionName: string): Promise<void> {
    const hook = this.hook;
    if (!hook || !desc) return;
    const turn = (this.turns.get(sessionName) ?? 0) + 1;
    this.turns.set(sessionName, turn);
    try {
      await hook(desc, turn);
    } catch (err) {
      getLogger().warn("session", "afterTurn hook failed", {
        storyId: desc.storyId,
        sessionName,
        error: errorMessage(err),
      });
    }
  }
}
