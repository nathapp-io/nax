/**
 * US-004 — the run's plugin loop-handler set turned into one turn's adapter
 * options.
 *
 * `SessionManager.sendPrompt` is the delivery seam: it already looks up the
 * session's descriptor, so it is also the place that can hand a native turn the
 * handler set `initializeAfterLock` stored plus the read-only facts
 * (`LoopHandlerContext`) a plugin scopes itself by. This module owns that one
 * translation — `{ handle, descriptor, set }` in, an options fragment out.
 *
 * Both keys are omitted rather than set to `undefined`: the native adapter
 * spreads these into `TurnDeps` conditionally, so a present-but-undefined key
 * would still read as "supplied" and defeat the plugin-free turn.
 *
 * The empty-set and non-native cases return `{}` — a session whose agent is not
 * native never receives handlers, and the manager says so once (see
 * `shouldLogNativeOnlyScope`).
 */

import type { LoopHandlerContext, LoopHandlerSet } from "../agents/native/session/loop-events/types";
import type { SessionHandle } from "../agents/session-types";
import { NATIVE_AGENT_NAME } from "../config";
import type { SessionDescriptor } from "./types";

/** What `buildLoopHandlerTurnOpts` may contribute to `adapter.sendTurn`'s options. */
export interface LoopHandlerTurnOpts {
  readonly loopHandlers?: LoopHandlerSet;
  readonly loopHandlerContext?: LoopHandlerContext;
}

/** The one `plugins` info line the native-only loop-handler scope emits. */
export const LOOP_HANDLERS_NATIVE_ONLY_MESSAGE = "loop handlers apply to the native agent only";

/**
 * Build the `loopHandlers` / `loopHandlerContext` pair for one native turn.
 *
 * Returns `{}` when there is nothing to deliver: an empty set, or a handle
 * whose agent is not the native one.
 */
export function buildLoopHandlerTurnOpts(input: {
  handle: SessionHandle;
  descriptor: SessionDescriptor | undefined;
  set: LoopHandlerSet;
}): LoopHandlerTurnOpts {
  if (input.set.length === 0 || input.handle.agentName !== NATIVE_AGENT_NAME) {
    return {};
  }
  return {
    loopHandlers: input.set,
    loopHandlerContext: buildLoopHandlerContext(input.handle, input.descriptor),
  };
}

/**
 * The read-only facts a plugin handler reads: the session it is running in and
 * the model the turn will use. Every field a caller cannot supply is omitted
 * rather than set to `undefined` — "no story" is the absence of the key.
 *
 * `sessionName` is the handle's id: that is the name the adapter and the
 * transcript know the session by. The descriptor's own id is a different thing
 * (`sess-<uuid>`) and would be useless to a plugin. With no descriptor there is
 * no session metadata at all, so only the handle's own role survives.
 */
function buildLoopHandlerContext(handle: SessionHandle, descriptor: SessionDescriptor | undefined): LoopHandlerContext {
  const role = descriptor ? descriptor.role : handle.role;
  const modelDef = handle.modelDef;
  return Object.freeze({
    sessionName: handle.id,
    ...(role !== undefined ? { role } : {}),
    ...(descriptor?.storyId !== undefined ? { storyId: descriptor.storyId } : {}),
    ...(descriptor?.featureName !== undefined ? { feature: descriptor.featureName } : {}),
    ...(descriptor?.workdir !== undefined ? { workdir: descriptor.workdir } : {}),
    ...(modelDef?.model !== undefined ? { model: modelDef.model } : {}),
    ...(modelDef?.provider !== undefined ? { provider: modelDef.provider } : {}),
  });
}

/**
 * Whether this manager should emit the native-only scope line for `handle`.
 *
 * True exactly once per manager per process: a non-empty set reaching a
 * non-native session is a real configuration mismatch worth saying out loud,
 * but saying it once is enough — the native adapter is the only consumer, and
 * repeating it per turn would drown the run's log.
 */
export function shouldLogNativeOnlyScope(set: LoopHandlerSet, handle: SessionHandle, alreadyLogged: boolean): boolean {
  return !alreadyLogged && set.length > 0 && handle.agentName !== NATIVE_AGENT_NAME;
}
