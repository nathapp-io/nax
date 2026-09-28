/**
 * The handlers the seam carries today (nax#2151, US-002, US-003). Installed in
 * order: the two built-in `before_tool` handlers — invalid-call repair and the
 * spin breaker — then every plugin entry the turn supplied, then the built-in
 * `after_tool` truncation. The first two were inline branches in `turn-loop.ts`
 * before the seam; they are ordinary registrations now, and the order they
 * register in is the order the loop consulted them before.
 *
 * The plugin entries sit BETWEEN the built-ins on purpose (US-003): a call the
 * repair already blocked or the breaker already terminated never reaches a
 * plugin handler (`dispatchBeforeTool` returns on the first block/terminate),
 * while a plugin `before_tool` handler still judges the call the tool would
 * actually receive, after null-optional repair. Truncation registers LAST among
 * `after_tool` handlers, which is the position the loop's hardcoded call held:
 * it shapes whatever the plugin `after_tool` entries produced, before the
 * result is built.
 *
 * All of them are PER-TURN — the invalid-call budget, the spin reprieve, the
 * plugin set with its context and signal, and the session whose spill root
 * truncation resolves all reset or are re-supplied with the turn — but they are
 * installed ONCE per registry, with the per-turn state swapped underneath them.
 * Registering a fresh set every turn would accumulate handlers on a registry a
 * caller reuses across turns, each set still closing over the turn that created
 * it: a later turn would be judged by an earlier turn's budget, the shared
 * breaker would be advanced once per installed pair — halving every threshold
 * it is supposed to enforce — and a plugin handler would run once per turn
 * installed instead of once per dispatch.
 *
 * The wrapped plugin entries read the current turn through `state` rather than
 * from whatever was in scope at install time, so a repointed registry hands
 * them the new context and the new signal.
 */

import type { ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import { type SpinBreaker, spinTerminalNotice } from "@/runtime/spin-breaker";
import { type InvalidCallBudget, normalizeNullOptionals } from "./handle-invalid-tool-call";
import {
  type BeforeToolOutcome,
  type LoopEventRegistry,
  type LoopHandlerContext,
  type LoopHandlerSet,
  wrapExternalHandler,
} from "./loop-events";
import { createTruncationHandler } from "./truncation-handler";

export interface BuiltinLoopHandlerDeps {
  /**
   * The session the handlers run for. Truncation resolves its spill root
   * against it; read through `state.current` at dispatch like every other
   * per-turn dep, so a repointed registry never keeps a stale session.
   */
  readonly sessionName: string;
  /** Per-turn invalid-call budget. The loop reads `exceeded` for the halt. */
  readonly budget: InvalidCallBudget;
  /** Absent disables the breaker, exactly as `TurnDeps.spinBreaker` does. */
  readonly spinBreaker?: SpinBreaker;
  /**
   * Called when the breaker stops the batch (nax#2120). The loop spends one
   * terminal round trip on that stop, so it is the loop — not the handler —
   * that records what the stop means for the turn.
   */
  readonly onSpinStop: () => void;
  /**
   * The run's plugin-contributed handlers (US-003), staged by
   * `PluginRegistry.getLoopHandlers()` and forwarded per turn by the adapter.
   * Absent or empty is the normal case: the built-ins are then the whole
   * chain.
   */
  readonly loopHandlers?: LoopHandlerSet;
  /**
   * The read-only facts a plugin handler is handed at dispatch. Read through
   * `state.current` like every other per-turn dep, so a repointed registry
   * never keeps an earlier turn's context.
   */
  readonly loopHandlerContext?: LoopHandlerContext;
  /**
   * The turn's abort signal (US-003), handed to each wrapped plugin entry so
   * an abort lands on a pending plugin handler. Read-only: a plugin handler
   * gets no way to abort the turn.
   */
  readonly signal?: AbortSignal;
}

/** The state the installed handlers read. `current` is replaced every turn. */
interface BuiltinTurnState {
  current: BuiltinLoopHandlerDeps;
}

/** A signal that is never aborted, standing in when a turn supplied none. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * The context handed to a plugin handler. A caller that supplies handlers is
 * expected to supply the context with them, but a handler must never be handed
 * `undefined`: the fact it scopes itself by is the session's own name, which
 * nax always knows.
 */
function contextFor(state: BuiltinTurnState): LoopHandlerContext {
  return state.current.loopHandlerContext ?? { sessionName: state.current.sessionName };
}

/**
 * A live view of the turn's signal. The wrapped plugin entries are installed
 * once per registry, while the signal is repointed with the rest of the
 * per-turn state, so the view reads `state.current.signal` when the wrapper
 * subscribes instead of capturing whatever was in scope at install time.
 *
 * `raceSettlement` subscribes and unsubscribes and nothing else, so those two
 * methods are the whole surface this view has to answer.
 */
function turnSignalView(state: BuiltinTurnState): AbortSignal {
  const current = (): AbortSignal => state.current.signal ?? NEVER_ABORTED;
  return {
    get aborted(): boolean {
      return current().aborted;
    },
    addEventListener: (...args: Parameters<AbortSignal["addEventListener"]>) => current().addEventListener(...args),
    removeEventListener: (...args: Parameters<AbortSignal["removeEventListener"]>) =>
      current().removeEventListener(...args),
  } as unknown as AbortSignal;
}

/**
 * One entry per registry the built-ins are installed on, so a second call for
 * the same registry is a repoint rather than a second pair. Weak, so the
 * loop's own per-turn registry takes its state with it when the turn ends.
 */
const turnStateByRegistry = new WeakMap<LoopEventRegistry, BuiltinTurnState>();

export function registerBuiltinLoopHandlers(registry: LoopEventRegistry, deps: BuiltinLoopHandlerDeps): void {
  const installed = turnStateByRegistry.get(registry);
  if (installed !== undefined) {
    installed.current = deps;
    return;
  }
  const state: BuiltinTurnState = { current: deps };
  turnStateByRegistry.set(registry, state);
  // Registered first, which is the pre-seam order: a malformed call is refused
  // before the spin breaker counts it. The empty string produced no rejected
  // keys, so counting a malformed call as spin evidence is how nax#2047's 69
  // identical bad calls stayed invisible.
  registry.register("before_tool", ({ call, tools }) => repairInvalidCall(state, call, tools));
  registry.register("before_tool", ({ call }) => observeSpin(state, call));
  // US-003: the plugin entries go between the built-in pair above and the
  // built-in truncation below, so a call a built-in already refused is never
  // offered to a plugin — `dispatchBeforeTool` returns on the first
  // block/terminate — while a plugin `before_tool` handler still judges the
  // repaired call. Each handler and its context are read through `state`, so
  // the entries installed here are the same ones a repointed registry
  // dispatches, with the turn's own facts.
  for (const entry of deps.loopHandlers ?? []) {
    registry.register(
      entry.event,
      wrapExternalHandler(entry, () => contextFor(state), turnSignalView(state)),
    );
  }
  // Registered LAST among after_tool handlers, which is the pre-seam position:
  // the loop's hardcoded truncation call ran after the dispatcher, so it shaped
  // whatever the handlers produced. The handler is rebuilt per dispatch so the
  // session name is read through `state.current` — the same lifetime the other
  // per-turn deps use — rather than frozen at install time.
  registry.register("after_tool", (payload) => createTruncationHandler(state.current.sessionName)(payload));
}

function repairInvalidCall(
  state: BuiltinTurnState,
  call: ToolCall,
  tools: readonly ToolDefinition[],
): BeforeToolOutcome {
  const invalid = state.current.budget.observe(call, tools);
  if (invalid === undefined) {
    // nax#2200: a `null` optional property validated as absent, so the tool
    // must receive it absent too — the rewrite is what the loop runs and
    // records. No `null` to drop leaves the success path untouched.
    const normalized = normalizeNullOptionals(call, tools);
    return normalized === undefined ? { kind: "allow" } : { kind: "allow", input: normalized };
  }
  if (invalid.kind === "stopped") {
    // A tripped budget ends the batch with NO tool-result — "a result nobody
    // reads only grows the transcript" (nax#2047 Task 4). None of the four
    // outcome kinds can express that (each of them answers the call), so the
    // loop reads the halt from `budget.exceeded` and breaks before applying
    // this outcome.
    return { kind: "allow" };
  }
  // Repaired, not executed: the loop records the model's input minus the
  // rejected property on the assistant message, and answers with the error
  // text, which carries the exemplar (nax#2200).
  return { kind: "block", content: invalid.content, isError: true, input: invalid.input };
}

function observeSpin(state: BuiltinTurnState, call: ToolCall): BeforeToolOutcome {
  const { budget, spinBreaker, onSpinStop } = state.current;
  // The budget halt wins: the turn ends without executing this call, so
  // letting the breaker count it would record a call that never ran.
  if (budget.exceeded) return { kind: "allow" };
  const verdict = spinBreaker?.observe(call.name, call.input) ?? { action: "allow" as const };
  if (verdict.action === "stop") {
    onSpinStop();
    return { kind: "terminate", content: spinTerminalNotice(verdict.reason), isError: true };
  }
  if (verdict.action === "nudge") return { kind: "nudge", text: verdict.text };
  return { kind: "allow" };
}
