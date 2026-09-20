/**
 * The two built-in `before_tool` handlers the seam carries today (nax#2151,
 * US-002). Both were inline branches in `turn-loop.ts` before the seam; they
 * are ordinary registrations now, and the order they register in is the order
 * the loop consulted them before.
 *
 * They are PER-TURN — the invalid-call budget and the spin reprieve both reset
 * with the turn — but they are installed ONCE per registry, with the per-turn
 * state swapped underneath them. Registering a fresh pair every turn would
 * accumulate handlers on a registry a caller reuses across turns, each pair
 * still closing over the turn that created it: a later turn would be judged by
 * an earlier turn's budget, and the shared breaker would be advanced once per
 * installed pair, halving every threshold it is supposed to enforce.
 */

import type { ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import { type SpinBreaker, spinTerminalNotice } from "@/runtime/spin-breaker";
import type { InvalidCallBudget } from "./handle-invalid-tool-call";
import type { BeforeToolOutcome, LoopEventRegistry } from "./loop-events";

export interface BuiltinLoopHandlerDeps {
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
}

/** The state the installed handlers read. `current` is replaced every turn. */
interface BuiltinTurnState {
  current: BuiltinLoopHandlerDeps;
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
  registry.registerBeforeTool((call, tools) => repairInvalidCall(state, call, tools));
  registry.registerBeforeTool((call) => observeSpin(state, call));
}

function repairInvalidCall(
  state: BuiltinTurnState,
  call: ToolCall,
  tools: readonly ToolDefinition[],
): BeforeToolOutcome {
  const invalid = state.current.budget.observe(call, tools);
  if (invalid === undefined) return { kind: "allow" };
  if (invalid.kind === "stopped") {
    // A tripped budget ends the batch with NO tool-result — "a result nobody
    // reads only grows the transcript" (nax#2047 Task 4). None of the four
    // outcome kinds can express that (each of them answers the call), so the
    // loop reads the halt from `budget.exceeded` and breaks before applying
    // this outcome.
    return { kind: "allow" };
  }
  // Repaired, not executed: the loop records the corrected input on the
  // assistant message and answers with the error text.
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
