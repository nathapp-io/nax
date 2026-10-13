/** Per-turn work SessionManager runs around adapter.sendTurn: plugin loop handlers, and the before/after turn hooks (#2497, nax#2500). */

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
export type BeforeTurnHook = (desc: SessionDescriptor) => Promise<void>;
export interface TurnHookPair {
  readonly before?: (desc: SessionDescriptor) => Promise<void>;
  readonly after?: (desc: SessionDescriptor, turn: number) => Promise<void>;
}

export class TurnHooks {
  private scopeLogged = false;
  private pair: TurnHookPair = {};
  private readonly turns = new Map<string, number>();

  setHooks(pair: TurnHookPair): void {
    this.pair = pair;
  }

  /** Runs the before hook (never throws), then returns the loop-handler opts; one call site in sendPrompt (nax#2500). */
  async beginTurn(handle: SessionHandle, descriptor: SessionDescriptor | undefined, set: LoopHandlerSet) {
    const before = this.pair.before;
    if (before && descriptor) {
      try {
        await before(descriptor);
      } catch (err) {
        getLogger().warn("session", "beforeTurn hook failed", {
          storyId: descriptor.storyId,
          sessionName: handle.id,
          error: errorMessage(err),
        });
      }
    }
    return this.loopHandlerOpts(handle, descriptor, set);
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
    const hook = this.pair.after;
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
