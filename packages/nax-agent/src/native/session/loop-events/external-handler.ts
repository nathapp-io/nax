/**
 * US-002 — `wrapExternalHandler()`: bounded lifetime, context and attributed
 * failure for plugin-contributed loop handlers.
 *
 * A `src/hooks/` handler is a child process with a 5s timeout; a plugin loop
 * handler is an IN-PROCESS function called from inside `runNativeTurn`, so
 * nothing bounds it and nothing catches it. A handler that never settles would
 * hang the turn, and a handler that throws must not be able to silently pass a
 * tool guard. This module answers both, for one staged entry at a time, and it
 * never rethrows: a plugin's defect must not fail the turn.
 *
 * The payload is handed over untouched — including for `before_tool`, whose
 * answer is a DECISION (`allow`/`nudge`/`block`/`terminate`) rather than a
 * field patch. That answer is therefore validated rather than field-picked: a
 * plugin module is plain JavaScript, is loaded from disk, and can return
 * anything at all.
 */

import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { isCompleteBeforeToolOutcome } from "./registry.ts";
import type { HandlerOf, LoopEvent, LoopHandlerContext, LoopHandlerEntry, PatchOf, PayloadOf } from "./types.ts";

/**
 * How long a plugin handler may run before the wrapper answers for it. A
 * constant by ruling, not a `NaxConfig` key: it bounds the turn's liveness, it
 * is not a policy a project tunes per package. An entry with its own
 * `timeoutMs` replaces it for that handler alone (US-001 — see `deadlineFor`).
 */
export const LOOP_HANDLER_TIMEOUT_MS = 10_000;

/**
 * The handle the deadline timer is armed with. Bun's `Timer` and a virtual
 * clock's numeric id are the same thing at runtime, and the test seam below
 * carries either.
 */
type TimerHandle = number | ReturnType<typeof setTimeout>;

interface ExternalHandlerDeps {
  /**
   * Test seam for the deadline only. Read at DISPATCH time, never captured
   * when the handler is wrapped — a wrapped handler is installed once and
   * dispatched many times.
   */
  timeoutMs: number;
  /**
   * The timer pair the deadline is armed on. Injected rather than called on the
   * globals so a test can drive the deadline on `makeFakeClock()` instead of
   * sleeping for it (`docs/guides/testing-rules.md` §3 forbids a fixed sleep,
   * and "wait a real 100 ms and hope the 10 ms default lost the race" is the
   * flake it forbids).
   *
   * The defaults READ the globals at call time instead of capturing them, so a
   * `withTimerSpy` substitution still observes the timer the wrapper arms.
   */
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
}

export const _externalHandlerDeps: ExternalHandlerDeps = {
  timeoutMs: LOOP_HANDLER_TIMEOUT_MS,
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    if (handle !== undefined) globalThis.clearTimeout(handle);
  },
};

/**
 * The deadline THIS dispatch is bounded by (US-001): the entry's own when it is
 * a finite positive number, the module default otherwise.
 *
 * `0` and `Infinity` are not deadlines — one would answer before the handler
 * was ever called, the other would disable the bound — so they fall back to the
 * default rather than being trusted as an override. `NaN` is not finite and
 * falls back the same way.
 */
function deadlineFor(entry: LoopHandlerEntry): number {
  const override = entry.timeoutMs;
  if (override === undefined || !Number.isFinite(override) || override <= 0) return _externalHandlerDeps.timeoutMs;
  return override;
}

/**
 * The patch fields whose presence is worth tracing: the ones a later
 * `applyHistoryPatch` can reject, so a rejection is attributable to a plugin.
 */
const TRACED_PATCH_FIELDS: readonly string[] = ["seed", "history", "messages", "summary"];

/** Why a handler did not settle: a throw, a rejection, the deadline, the abort. */
type FailureReason = string;

type Settlement =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: FailureReason };

/**
 * Race the handler's settlement against the deadline and the turn's abort. The
 * first to settle wins, every later settlement is discarded, and the timer is
 * cleared the moment the race settles so an instant handler never holds the
 * event loop open for the full deadline.
 *
 * The abort is honoured for the lifetime of THIS dispatch: the listener is
 * wired synchronously, before the handler is called. A signal that was already
 * aborted when the dispatch began is deliberately NOT honoured — one registry
 * is installed once and repointed per turn (`./loop-handlers`), so a signal
 * carried over from an earlier turn would otherwise fail-close every later
 * `before_tool` dispatch to `block` without ever calling the handler. The
 * deadline still bounds such a dispatch, so nothing hangs.
 *
 * `setTimeout` and not `Bun.sleep()`: the handle has to be cancelled mid-flight
 * (`clearTimeout`), which is the sanctioned exception to the Bun-native delay
 * rule. Both go through `_externalHandlerDeps`, whose defaults forward to the
 * globals at call time (see its doc).
 *
 * `timeoutMs` is the entry's own deadline when it has one — `deadlineFor` — so
 * a long-running hook widens only its own bound.
 */
function raceSettlement(
  entry: LoopHandlerEntry,
  payload: unknown,
  deps: { readonly getCtx: () => LoopHandlerContext; readonly signal: AbortSignal },
): Promise<Settlement> {
  const timeoutMs = deadlineFor(entry);
  return new Promise<Settlement>((resolve) => {
    let settled = false;
    let timer: TimerHandle | undefined;
    const finish = (result: Settlement): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) _externalHandlerDeps.clearTimeout(timer);
      deps.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ ok: false, reason: "aborted before it settled" });
    timer = _externalHandlerDeps.setTimeout(
      () => finish({ ok: false, reason: `did not settle within ${timeoutMs}ms` }),
      timeoutMs,
    );
    deps.signal.addEventListener("abort", onAbort, { once: true });
    // The context is read here, at dispatch, so a handler always sees the facts
    // of the turn it is running in. Read in its OWN try: a `getCtx` throw is
    // nax's own defect, and it must not be reported as the plugin's handler
    // failing (US-002 review).
    let ctx: LoopHandlerContext;
    try {
      ctx = deps.getCtx();
    } catch (err) {
      finish({ ok: false, reason: `reading the handler context failed: ${errorMessage(err)}` });
      return;
    }
    let returned: unknown;
    try {
      returned = entry.handler(payload as PayloadOf<LoopEvent>, ctx);
    } catch (err) {
      finish({ ok: false, reason: errorMessage(err) });
      return;
    }
    Promise.resolve(returned).then(
      (value) => finish({ ok: true, value }),
      (err) => finish({ ok: false, reason: errorMessage(err) }),
    );
  });
}

/**
 * The attributed failure. On `before_tool` the call is answered with an error
 * block — a failed guard must never read as a silent allow — and every other
 * event answers `{}` (no patch). One warn per failure either way, naming the
 * plugin the failure belongs to.
 *
 * The tool name is read defensively: this runs on the failure path, outside any
 * try, and a wrapper whose contract is that it never rethrows must not throw
 * from its own diagnosis of a malformed payload.
 */
function failure(entry: LoopHandlerEntry, payload: unknown, reason: FailureReason): PatchOf<LoopEvent> {
  const logger = getSafeLogger();
  if (entry.event === "before_tool") {
    const tool = (payload as { readonly call?: { readonly name?: string } } | undefined)?.call?.name;
    logger?.warn("native-loop-events", `plugin '${entry.plugin}' failed on before_tool; blocking the call`, {
      plugin: entry.plugin,
      event: entry.event,
      ...(tool !== undefined ? { tool } : {}),
      error: reason,
    });
    return {
      kind: "block",
      isError: true,
      content: `Blocked: loop handler from plugin '${entry.plugin}' failed (${reason}).`,
    };
  }
  logger?.warn("native-loop-events", `plugin '${entry.plugin}' failed on ${entry.event}`, {
    plugin: entry.plugin,
    event: entry.event,
    error: reason,
  });
  return {};
}

/**
 * Log which patch fields a handler carried, so a later `applyHistoryPatch`
 * rejection can be traced back to the plugin that caused it. An empty patch
 * traces nothing — there is no field to attribute.
 */
function tracePatch(entry: LoopHandlerEntry, value: unknown): void {
  // A plain-JavaScript plugin can answer a non-object on any event; there is
  // then no field to attribute, and reading one must not throw.
  if (typeof value !== "object" || value === null) return;
  const patch = value as Record<string, unknown>;
  const fields = TRACED_PATCH_FIELDS.filter((field) => patch[field] !== undefined);
  if (fields.length === 0) return;
  getSafeLogger()?.debug("native-loop-events", `plugin '${entry.plugin}' patched ${entry.event}`, {
    plugin: entry.plugin,
    event: entry.event,
    fields,
  });
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object whose kind is not a before_tool outcome";
  return `a ${typeof value} value`;
}

/** What a settled (non-failure) handler answer becomes. */
function settled(entry: LoopHandlerEntry, payload: unknown, value: unknown): PatchOf<LoopEvent> {
  if (entry.event === "before_tool") {
    // `undefined` is the handler declining to decide, which is an allow.
    if (value === undefined) return { kind: "allow" };
    // The plugin boundary, so the answer must be COMPLETE: a `kind` without
    // the payload it promises (`block`/`terminate` content, `nudge` text) is
    // malformed, not a decision.
    if (!isCompleteBeforeToolOutcome(value)) return failure(entry, payload, `returned ${describeValue(value)}`);
    return value;
  }
  if (value === undefined) return {};
  tracePatch(entry, value);
  return value as PatchOf<LoopEvent>;
}

/**
 * Wrap one staged plugin registration into a built-in-shaped `HandlerOf<E>`:
 * same payload, same patch, but with a bounded lifetime, the turn's context,
 * and a failure that is attributed and never rethrown.
 */
export function wrapExternalHandler<E extends LoopEvent>(
  entry: LoopHandlerEntry,
  getCtx: () => LoopHandlerContext,
  signal: AbortSignal,
): HandlerOf<E> {
  return async (payload: PayloadOf<E>): Promise<PatchOf<E>> => {
    const settlement = await raceSettlement(entry, payload, { getCtx, signal });
    // `entry.event` carries the event at runtime; the erased patch is the union
    // the dispatcher re-narrows, because it registered this handler per event.
    const answer = settlement.ok
      ? settled(entry, payload, settlement.value)
      : failure(entry, payload, settlement.reason);
    return answer as PatchOf<E>;
  };
}
