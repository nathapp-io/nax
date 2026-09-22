/**
 * The native session's in-process loop event seam (nax#2151, US-002).
 *
 * Typed function registrations, not an extension of `src/hooks/`: those events
 * fire around a story, shell out with a 5s timeout, and cannot carry a
 * rewritten tool result. Two events exist because two have real consumers
 * today — invalid-call repair and the spin breaker on `before_tool`, and the
 * truncation policy on `after_tool`.
 *
 * The dispatcher enforces four rules rather than leaving them to handler
 * authors, because those rules are what let a future event be added without
 * redesigning the seam:
 *
 *  1. Results are partial patches, never mutations. A handler returns only what
 *     it wants changed and the dispatcher merges. No handler receives the
 *     message array.
 *  2. Handlers chain, each seeing the previous handler's output, in
 *     registration order.
 *  3. A throwing handler is logged at warn and skipped — it never fails the
 *     turn for its own defect. A rejected promise counts as a throw (spec
 *     4.2): the await sits inside the try, so a handler whose promise rejects
 *     is logged-and-skipped identically to one that throws — a bare try/catch
 *     catches only the throw.
 *  4. No handler may rewrite history. Measured prompt-cache hit rate on the
 *     native path is 96.7%, and Anthropic-style caching is prefix-matched, so
 *     rewriting anything early in the array re-bills every downstream turn at
 *     input rather than cacheRead — roughly 5x more expensive, not cheaper.
 *     `after_tool` is safe by construction: it shapes a result before the
 *     result enters the array. Across the full event set that safety is no
 *     longer left to construction — the cache-boundary checker (spec 4.7, §3)
 *     enforces it mechanically.
 */

import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import type { BeforeToolOutcome, BeforeToolPayload, HandlerOf, LoopEvent, PatchOf, PayloadOf } from "./types";

export interface LoopEventRegistry {
  register<E extends LoopEvent>(event: E, handler: HandlerOf<E>): void;
  dispatch<E extends LoopEvent>(event: E, payload: PayloadOf<E>): Promise<PatchOf<E>>;
}

/**
 * The fields each event's patch type declares, keyed by event. Only these are
 * read off a handler's return, so a handler that bypasses the type cannot
 * surface a non-patchable field. The `satisfies` keeps this map aligned with
 * the patch types in `./types`: a patch field must appear here under its own
 * event, or typecheck fails.
 */
const PATCHABLE_FIELDS = {
  // A decision, not a field patch — chained in dispatchBeforeTool below.
  before_tool: [],
  after_tool: ["content", "isError"],
  before_turn: ["seed", "history"],
  transform_context: ["messages"],
  before_request: ["options"],
  after_response: ["text", "toolCalls", "thinking"],
  before_compaction: ["decline", "summary"],
  before_turn_end: ["followUp"],
} as const satisfies { [E in LoopEvent]: readonly (keyof PatchOf<E>)[] };

/**
 * Only the patchable fields are read, so a handler that returns a
 * denied-bearing object (bypassing the type) cannot surface one — the same
 * defence keeps `usage` off an `after_response` patch, and every other event's
 * surfaced-only fields out of its patch.
 */
function pickPatchFields(returned: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof returned !== "object" || returned === null) return {};
  const source = returned as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined) picked[field] = value;
  }
  return picked;
}

/**
 * Registration order is the chain order. `block` and `terminate` are a single
 * decision, not a chained one: they short-circuit, because the outcome is the
 * dispatcher's verdict and a later handler must not be able to veto it.
 *
 * `before_tool` is the one event whose patch is a DECISION, not a field patch,
 * so it does not share the merge chain: an empty chain must still yield a
 * verdict (`allow`, exactly as the pre-map dispatcher returned), and the thing
 * a later handler sees is the accumulated input rewrite inside the call, not a
 * merged payload.
 */
async function dispatchBeforeTool(
  handlers: readonly HandlerOf<LoopEvent>[],
  payload: BeforeToolPayload,
): Promise<BeforeToolOutcome> {
  const { call, tools } = payload;
  let input: Record<string, unknown> | undefined;
  let nudgeText: string | undefined;
  for (const handler of handlers) {
    let outcome: BeforeToolOutcome;
    try {
      // Each handler sees the previous handler's output, so an `allow`
      // rewrite is what the next one judges — and what the loop runs.
      outcome = await (handler as HandlerOf<"before_tool">)({
        call: { ...call, input: input ?? call.input },
        tools,
      });
    } catch (err) {
      getSafeLogger()?.warn("native-loop-events", "before_tool handler threw; skipping it", {
        tool: call.name,
        error: errorMessage(err),
      });
      continue;
    }
    if (outcome.kind === "block" || outcome.kind === "terminate") return outcome;
    if (outcome.kind === "nudge") nudgeText = outcome.text;
    else if (outcome.input !== undefined) input = outcome.input;
  }
  // A `nudge` outcome carries no input, so an `allow` rewrite accumulated
  // earlier in the chain cannot ride along with it: the loop reads the
  // rewrite only off an `allow`. No built-in handler produces the
  // combination today (only the spin breaker nudges, and it never rewrites
  // input), but this dispatcher is the general seam, so a later handler
  // pairing the two would otherwise lose its correction with no trace.
  if (nudgeText !== undefined && input !== undefined) {
    getSafeLogger()?.warn("native-loop-events", "before_tool nudge discards an accumulated input rewrite", {
      tool: call.name,
    });
  }
  if (nudgeText !== undefined) return { kind: "nudge", text: nudgeText };
  return input === undefined ? { kind: "allow" } : { kind: "allow", input };
}

/**
 * The seven field-patch events. Serial `for`, each handler awaited INSIDE the
 * try (spec 4.2), patches accumulated in registration order, each handler
 * seeing the previous one's output as the payload it is handed.
 */
async function dispatchChain<E extends LoopEvent>(
  event: E,
  handlers: readonly HandlerOf<LoopEvent>[],
  payload: PayloadOf<E>,
): Promise<PatchOf<E>> {
  if (handlers.length === 0) {
    // The empty fast path returns BEFORE touching the payload — never clone:
    // transform_context fires before every request against a 200k+ token
    // array, and cloning for an empty chain would make every request
    // allocate a full copy for nothing (spec 4.4).
    return {} as PatchOf<E>;
  }
  const fields: readonly string[] = PATCHABLE_FIELDS[event];
  let current = payload;
  let accumulated: Record<string, unknown> = {};
  for (const handler of handlers) {
    let returned: unknown;
    try {
      // The await sits inside the try, so a rejected promise is caught
      // exactly like a throw (spec 4.2).
      returned = await handler(current);
    } catch (err) {
      // When the payload carries a tool name (after_tool does), the warn
      // names the tool the failing handler was shaping — the context the
      // first-argument dispatcher carried as `tool: call.name` before the
      // single-payload signature replaced it.
      const { toolName } = payload as { readonly toolName?: string };
      getSafeLogger()?.warn("native-loop-events", `${event} handler threw; skipping it`, {
        event,
        ...(toolName !== undefined ? { tool: toolName } : {}),
        error: errorMessage(err),
      });
      continue;
    }
    const picked = pickPatchFields(returned, fields);
    if (Object.keys(picked).length > 0) {
      accumulated = { ...accumulated, ...picked };
      // Only patch-declared fields ever overwrite anything, so the next
      // handler sees the previous handler's output and nothing else moved.
      current = { ...current, ...picked } as PayloadOf<E>;
    }
  }
  // Sound: `accumulated` holds only fields PATCHABLE_FIELDS declares for this
  // event, which is exactly what PatchOf<E> declares.
  return accumulated as PatchOf<E>;
}

/**
 * Registration order is the chain order within each event; events are
 * independent chains. The built-ins register on the same registry the loop
 * dispatches from (see ./loop-handlers for their per-turn lifetime).
 */
export function createLoopEventRegistry(): LoopEventRegistry {
  const byEvent = new Map<LoopEvent, HandlerOf<LoopEvent>[]>();

  return {
    register(event, handler) {
      // Erase E for storage: the map keys by event, and dispatch only ever
      // calls a handler back with the payload type it registered for, so the
      // widening loses nothing at the call sites.
      const erased = handler as unknown as HandlerOf<LoopEvent>;
      const handlers = byEvent.get(event);
      if (handlers === undefined) {
        byEvent.set(event, [erased]);
        return;
      }
      handlers.push(erased);
    },

    async dispatch(event, payload) {
      const handlers = byEvent.get(event) ?? [];
      if (event === "before_tool") {
        return dispatchBeforeTool(handlers, payload as BeforeToolPayload) as Promise<PatchOf<typeof event>>;
      }
      return dispatchChain(event, handlers, payload);
    },
  };
}
