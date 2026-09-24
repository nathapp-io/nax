/**
 * The human link of the ask chain (P2 design 5, 6.5a).
 *
 * An ADAPTER, not a channel: it renders an AskRequest into the interaction
 * subsystem's existing vocabulary and dispatches through the chain every other
 * consumer uses. It adds no plugin and no second prompt path. The import of
 * @/permissions is now a RUNTIME import: `maskForPrompt` (review #9) masks
 * inert secret spans in the prompt and denies unshowable ones, so
 * `interaction -> permissions` is a real dependency edge (master plan D8).
 *
 * The dependency is the narrow structural `AskChannel` rather than
 * `InteractionChain` itself: the link only needs `prompt` and `cancel`, and a
 * narrow boundary keeps test doubles cast-free. `InteractionChain` satisfies it
 * structurally.
 */
import { type AskControl, type AskLink, type AskLinkOutcome, type AskRequest, maskForPrompt } from "@/permissions";
import { getSafeLogger } from "../logger";
import type { InteractionRequest } from "./types";

/** Headroom under MAX_MESSAGE_CHARS (4000) for the header, reason and footer. */
const MAX_COMMAND_CHARS = 3500;

/** What the prompt shows: the command with inert secret spans masked (review #9, D18). */
interface PromptView {
  readonly command: string;
  readonly maskedCount: number;
}

const maskedFooter = (count: number): string => `${count} secret value(s) masked; the approved command contains them`;

/**
 * Injectable keepalive timing for the human ask link (US-004).
 *
 * While a human approval prompt is pending, the link calls every live waiter's
 * `onWaiting` once per period — re-arming a cancellable `setTimeout` each time
 * (never `setInterval`) and clearing the timer on every settlement. The
 * interval is deliberately internal, not configuration (out of scope for
 * US-004); tests swap the timer functions for a fake clock.
 */
export const _askLinkDeps = {
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)) as (id: unknown) => void,
  ASK_KEEPALIVE_MS: 60_000,
};

/** The subset of a response a permission prompt reads. */
export interface AskChannelResponse {
  readonly action: string;
  readonly respondedBy?: string;
  readonly value?: string;
  readonly requestId?: string;
  readonly respondedAt?: number;
}

/** The subset of the interaction channel a permission prompt needs. */
export interface AskChannel {
  prompt(request: InteractionRequest): Promise<AskChannelResponse>;
  cancel(requestId: string): Promise<void>;
}

const OPTIONS = [
  { key: "allow", label: "Allow once" },
  { key: "allow-remember", label: "Allow + remember" },
  { key: "deny", label: "Deny" },
];

/**
 * ONLY these permit. Everything else -- including unrecognised strings from a
 * future or malformed plugin -- denies. An allowlist, never a denylist.
 */
const PERMITS = new Set(["allow", "allow-remember"]);

/** An AskLink that also exposes the prompt currently awaiting a human. */
export interface HumanAskLink extends AskLink {
  pending(): string | undefined;
  cancel(): Promise<void>;
  dispose(): void;
}

export function createHumanAskLink(opts: {
  /**
   * `PipelineContext.interaction` is declared OPTIONAL (`src/pipeline/types.ts:142`), so it is
   * `InteractionChain | undefined`, while a chain built directly is `| null`. Accept both
   * rather than making every call site remember a `?? null` under `strict`.
   */
  readonly chain: AskChannel | null | undefined;
  readonly timeoutMs: number;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly onRemember?: (req: AskRequest) => Promise<void>;
  readonly abortSignal?: AbortSignal;
}): HumanAskLink {
  // One prompt in flight per run. CLI's readline is single-in-flight
  // (plugins/cli.ts:150-160) while Telegram is concurrent, so serializing HERE
  // makes gate behaviour independent of which channel is configured.
  let queue: Promise<unknown> = Promise.resolve();
  // The prompt id currently on-screen, if any. Same-key resolves share a single
  // prompt and therefore a single id; different keys are serialised through
  // `queue` and only one is ever on-screen at a time.
  let activeId: string | undefined;

  const deny = (decidedBy: "human" | "timeout" | "unavailable" | "cancelled" | "unshowable"): AskLinkOutcome => ({
    decision: "deny",
    decidedBy,
  });

  /**
   * One waiter per `resolve` call. Each one watches its own signal and
   * settles independently when that signal aborts -- that is what makes
   * AC4/AC6/AC7/AC8 possible: same-key resolve calls share the on-screen
   * prompt, but a signal abort cancels only that one waiter.
   *
   * `signal` and `onAbort` are kept on the waiter so a normal settlement
   * (adversarial finding) can detach the listener -- leaving it
   * attached would retain waiter/session state until the signal
   * eventually aborts.
   */
  interface Waiter {
    settle(outcome: AskLinkOutcome): void;
    done: Promise<AskLinkOutcome>;
    aborted: boolean;
    signal?: AbortSignal;
    onAbort?: () => void;
    /**
     * US-004: this waiter's per-call keepalive notifier. The session's
     * keepalive timer fires it for every live waiter once each
     * ASK_KEEPALIVE_MS so the turn-loop watchdog is told the native turn
     * is still legitimately waiting on a human approval prompt.
     */
    onWaiting?: () => void;
  }

  function makeWaiter(): Waiter {
    let settleFn: ((outcome: AskLinkOutcome) => void) | undefined;
    const done = new Promise<AskLinkOutcome>((resolve) => {
      settleFn = resolve;
    });
    return {
      settle: (outcome) => settleFn?.(outcome),
      done,
      aborted: false,
    };
  }

  /**
   * A "session" is the live prompt for one key. It carries the on-screen
   * prompt's id and the live waiters sharing it. A session is "settled"
   * when its prompt has resolved (or thrown), so a late-joining waiter
   * does not double-settle.
   */
  interface Session {
    readonly id: string;
    readonly waiters: Set<Waiter>;
    settled: boolean;
    /** Whether `chain.cancel(id)` has been called for this session. */
    cancelledOnChain: boolean;
    /** Releases the serial queue when a channel leaves its prompt pending after cancel. */
    cancelPrompt?: () => void;
    /**
     * US-004: the cancellable keepalive handle (`setTimeout`, never
     * `setInterval`). Re-armed by `runKeepalive` each time it fires, and
     * cleared in runSession's `finally` so a settled prompt never keepsalives
     * again. `undefined` means no keepalive has been armed yet.
     */
    keepaliveTimer?: unknown;
  }

  function attachWaiter(session: Session, control: AskControl | undefined): Waiter {
    const signal = control?.signal;
    const waiter = makeWaiter();
    // AC10 (deferred): recheck after the session is live. A signal that
    // aborted between resolve() being called and the queue microtask firing
    // still settles cancelled without ever joining the waiters set.
    if (signal?.aborted === true) {
      waiter.aborted = true;
      waiter.settle(deny("cancelled"));
      return waiter;
    }
    const onAbort = () => {
      if (waiter.aborted) return;
      waiter.aborted = true;
      waiter.settle(deny("cancelled"));
      session.waiters.delete(waiter);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      // AC5/AC8: zero live waiters cancels the on-screen prompt, exactly
      // once. `cancelledOnChain` guards against a second cancel arriving
      // after the prompt's own promise resolves (AC8 covers that race:
      // both waiters abort before the prompt resolves, so exactly one
      // cancel reaches the chain).
      if (session.waiters.size === 0 && !session.settled && !session.cancelledOnChain) {
        session.cancelledOnChain = true;
        session.settled = true;
        const chain = opts.chain;
        if (chain !== null && chain !== undefined) {
          void chain.cancel(session.id).catch(() => undefined);
        }
        session.cancelPrompt?.();
      }
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (session.settled) {
      // The prompt resolved before this waiter was attached. We have no
      // shared outcome to forward; a late joiner cannot get the prompt's
      // answer. Detach the listener and settle unavailable.
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      waiter.settle(deny("unavailable"));
      return waiter;
    }
    waiter.signal = signal;
    waiter.onAbort = onAbort;
    waiter.onWaiting = control?.onWaiting;
    session.waiters.add(waiter);
    return waiter;
  }

  /**
   * Notify the caller that its ask is waiting on a human prompt.
   *
   * Called once per `resolve` -- right after the waiter is attached to
   * the session, so the FIRST caller's onWaiting fires before the
   * prompt is on screen (advisory only -- the prompt becomes pending
   * inside runSession's chain.prompt). For a same-key joiner, the
   * prompt may already be on screen; onWaiting still fires so the
   * joiner's turn-loop watchdog is also notified. Errors are swallowed:
   * onWaiting is a notification, not a gate.
   */
  function notifyWaiting(control: AskControl | undefined, req: AskRequest): void {
    if (control?.onWaiting === undefined) return;
    try {
      control.onWaiting();
    } catch (err) {
      getSafeLogger()?.warn("permissions", "[ask] onWaiting threw; ignoring", {
        tool: req.tool,
        stage: req.stage,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * US-004: fire `onWaiting` for every live waiter on this session, then
   * re-arm the timer for another ASK_KEEPALIVE_MS. The timer is a
   * cancellable `setTimeout` (never `setInterval`), and a settled session
   * has its timer cleared in runSession's `finally` so a resolved prompt
   * never keepsalives again. Each waiter's own errors are swallowed
   * independently — a broken `onWaiting` on one waiter must not skip the
   * others, and must not stop the re-arm.
   */
  function runKeepalive(session: Session): void {
    if (session.settled) return;
    for (const w of [...session.waiters]) {
      if (w.aborted) continue;
      if (w.onWaiting === undefined) continue;
      try {
        w.onWaiting();
      } catch (err) {
        getSafeLogger()?.warn("permissions", "[ask] keepalive onWaiting threw; ignoring", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Re-arm — unless the session settled while the loop above was running.
    if (session.settled) return;
    session.keepaliveTimer = _askLinkDeps.setTimeout(() => runKeepalive(session), _askLinkDeps.ASK_KEEPALIVE_MS);
  }

  function clearKeepalive(session: Session): void {
    if (session.keepaliveTimer !== undefined) {
      _askLinkDeps.clearTimeout(session.keepaliveTimer);
      session.keepaliveTimer = undefined;
    }
  }

  /**
   * Drive one session's prompt. Called inside the serial queue, so only
   * one prompt is ever on-screen per run.
   */
  async function runSession(req: AskRequest, session: Session, view: PromptView): Promise<void> {
    const chain = opts.chain;
    try {
      if (chain === null || chain === undefined) {
        // No channel: every live waiter settles unavailable, none of them
        // are ever prompted.
        for (const w of [...session.waiters]) {
          w.settle(deny("unavailable"));
          if (w.signal !== undefined && w.onAbort !== undefined) {
            w.signal.removeEventListener("abort", w.onAbort);
          }
          session.waiters.delete(w);
        }
        session.settled = true;
        return;
      }
      // AC9: a queued waiter that aborted before its turn has already
      // settled cancelled; its session has no live waiters, so we must
      // NOT call chain.prompt (the test pins `promptCalls === 1` even when
      // the queued waiter is the only entry for its key).
      if (session.waiters.size === 0) {
        session.settled = true;
        return;
      }
      activeId = session.id;
      const promptCancelled = new Promise<null>((resolve) => {
        session.cancelPrompt = () => resolve(null);
      });
      // onWaiting is fired in resolve() before the session is queued, so
      // each caller's watchdog is notified exactly once.
      try {
        const response = await Promise.race([
          chain.prompt({
            id: session.id,
            type: "choose",
            featureName: opts.featureName ?? "unknown",
            ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
            stage: "execution",
            summary: `${req.tool} - approval required`,
            detail: [
              // A Write/Edit ask carries no command: showing `req.summary` keeps
              // the operator informed about what is being approved instead of an
              // empty code block. The command is shown with inert secret spans
              // masked (review #9); a command that cannot be shown safely never
              // reaches this prompt (denied `unshowable` in resolve).
              ...(view.command.length > 0 ? ["```", view.command, "```"] : []),
              ...(view.maskedCount > 0 ? [maskedFooter(view.maskedCount)] : []),
              `request: ${req.summary}`,
              `runs in: ${req.root ?? "unknown"}`,
              `reason:  ${req.reason ?? req.rule}`,
              `stage:   ${req.stage}`,
            ].join("\n"),
            options: OPTIONS,
            timeout: opts.timeoutMs,
            // Recorded for the message footer only. This link NEVER consults
            // applyFallback: it maps "continue" AND "escalate" to approve.
            fallback: "abort",
            createdAt: Date.now(),
            metadata: { approvalPrompt: true },
          }),
          promptCancelled,
        ]);
        if (response === null || session.waiters.size === 0) return;
        let outcome: AskLinkOutcome;
        if (response.respondedBy === "timeout") {
          outcome = deny("timeout");
        } else {
          // `action` is declared as InteractionAction ("approve" | "reject" |
          // "choose" | "input" | "skip" | "abort"), but prompt() remaps a
          // choose reply to the OPTION KEY through a cast
          // (src/interaction/chain.ts:135), so at runtime it carries our keys.
          // Widen to string once, here.
          const action: string = response.action;
          if (!PERMITS.has(action)) {
            outcome = deny("human");
          } else {
            if (action === "allow-remember" && opts.onRemember) {
              // Remembering is AUXILIARY: the human already approved this
              // exact call, so a failed persistence (lock timeout, disk)
              // must not revoke that approval. AWAITED so the approval is
              // recorded before the tool runs (adversarial finding:
              // fire-and-forget let the resolver return allow before the
              // approval was persisted, racing the next same-key call).
              try {
                await opts.onRemember(req);
              } catch (err) {
                getSafeLogger()?.warn("permissions", "[ask] approved call not remembered; allowing anyway", {
                  tool: req.tool,
                  stage: req.stage,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            outcome = { decision: "allow", decidedBy: "human" };
          }
        }
        // Settle every still-live waiter with the shared outcome. A waiter
        // that already aborted (and was removed from the set) is gone; a
        // waiter that aborts between snapshot and iteration gets the
        // outcome anyway (it does not matter whether its listener fires
        // before or after settle -- both are idempotent on `aborted`).
        for (const w of [...session.waiters]) {
          w.settle(outcome);
          // Detach the per-waiter abort listener so the caller's signal
          // does not retain a reference to this waiter/session forever
          // (adversarial finding).
          if (w.signal !== undefined && w.onAbort !== undefined) {
            w.signal.removeEventListener("abort", w.onAbort);
          }
          session.waiters.delete(w);
        }
      } catch {
        // Chain threw: every waiter settles unavailable.
        for (const w of [...session.waiters]) {
          w.settle(deny("unavailable"));
          if (w.signal !== undefined && w.onAbort !== undefined) {
            w.signal.removeEventListener("abort", w.onAbort);
          }
          session.waiters.delete(w);
        }
      } finally {
        session.settled = true;
        // Clear `activeId` so `pending()` no longer reports a stale prompt
        // id (adversarial finding: activeId is never cleared after a
        // prompt settles). `activeId` may point at THIS session OR an
        // earlier one that ran through before the queue caught up; clear
        // in both cases by re-reading the queue's tail.
        if (activeId === session.id) activeId = undefined;
      }
    } finally {
      session.settled = true;
      session.cancelPrompt = undefined;
      if (activeId === session.id) activeId = undefined;
      for (const [key, current] of liveSessions) {
        if (current === session) liveSessions.delete(key);
      }
      // US-004: a settled prompt must never keepalive again, even on the
      // no-chain / queued-aborted early-return paths that bypass the inner
      // try/finally. Without this outer guard the timer remains armed until
      // its next 60-second firing and retains the session closure. The
      // outer guard also handles the chain.prompt path because the inner
      // finally does not run before this finally on the early-return
      // branches — and calling clearKeepalive twice is a no-op.
      clearKeepalive(session);
    }
  }

  /**
   * A "live" key is one whose session has been scheduled but has not yet
   * settled. We track this so same-key resolves join the same session
   * (AC6/AC7/AC8). The map is keyed by `${stage}\0${tool}\0${command}`
   * (review #21); a command-less ask is keyed uniquely as
   * `\u0001${sessionId}` and is never joined. Entries are cleared when the
   * session settles.
   */
  const liveSessions = new Map<string, Session>();

  function resolve(req: AskRequest, control?: AskControl): Promise<AskLinkOutcome> {
    // AC10: an already-aborted signal settles cancelled without joining
    // the queue or prompting at all.
    if (control?.signal?.aborted === true) {
      return Promise.resolve(deny("cancelled"));
    }
    if (req.unshowable === true) {
      return Promise.resolve(deny("unshowable"));
    }
    const command = req.command ?? "";
    const masked = maskForPrompt(command);
    if (!masked.ok) {
      return Promise.resolve(deny("unshowable"));
    }
    const footerChars = masked.count > 0 ? maskedFooter(masked.count).length + 1 : 0;
    if (masked.masked.length + footerChars > MAX_COMMAND_CHARS) {
      return Promise.resolve(deny("unavailable"));
    }
    const view: PromptView = { command: masked.masked, maskedCount: masked.count };
    // Review #21: the tool is part of the key, and a command-less ask (Write,
    // Edit, argv-only Exec) is never joined: two different writes must not
    // share one answer. It still enters liveSessions under a unique key so
    // cancel() and settle-time cleanup reach it.
    const key = command === "" ? undefined : `${req.stage}\u0000${req.tool}\u0000${command}`;
    const existing = key === undefined ? undefined : liveSessions.get(key);
    if (existing !== undefined && !existing.settled) {
      notifyWaiting(control, req);
      return attachWaiter(existing, control).done;
    }
    const session: Session = {
      id: `ask-${Math.random().toString(16).slice(2, 10)}`,
      waiters: new Set(),
      settled: false,
      cancelledOnChain: false,
    };
    liveSessions.set(key ?? `\u0001${session.id}`, session);
    // First caller for this key: notify its watchdog before scheduling.
    notifyWaiting(control, req);
    // US-004: arm the per-session keepalive timer now, before the queue.
    // The first onWaiting fired synchronously above; the timer fires for
    // every live waiter once each ASK_KEEPALIVE_MS thereafter, re-arming
    // itself each time. `clearKeepalive` in runSession's `finally` stops
    // it the moment the prompt settles (allow / deny / timeout / throw /
    // chain.cancel).
    session.keepaliveTimer = _askLinkDeps.setTimeout(() => runKeepalive(session), _askLinkDeps.ASK_KEEPALIVE_MS);
    // Chain onto the queue and ALWAYS clear it, so a throw cannot leave
    // the mutex held and deadlock every later ask in the run.
    queue = queue
      .then(() => runSession(req, session, view))
      .then(
        () => undefined,
        () => undefined,
      );
    return attachWaiter(session, control).done;
  }

  /**
   * Settle every live waiter as `deny/unavailable` and cancel the
   * on-screen prompt.
   *
   * The story's "out of scope" list pins this as `unavailable` -- the
   * link-level `abortSignal` still settles unavailable, never
   * `cancelled`. Only the PER-WAITER signal (an AskControl.signal on a
   * single resolve call) settles `cancelled`.
   */
  function settleAllUnavailable(): void {
    for (const session of liveSessions.values()) {
      if (session.settled) continue;
      for (const w of [...session.waiters]) {
        w.settle(deny("unavailable"));
        if (w.signal !== undefined && w.onAbort !== undefined) {
          w.signal.removeEventListener("abort", w.onAbort);
        }
        session.waiters.delete(w);
      }
      session.settled = true;
      session.cancelPrompt?.();
    }
  }

  async function cancel(): Promise<void> {
    settleAllUnavailable();
    const id = activeId;
    const chain = opts.chain;
    if (id !== undefined && chain !== null && chain !== undefined) {
      await chain.cancel(id).catch(() => undefined);
    }
  }

  const onAbort = () => {
    void cancel();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  return {
    name: "human",
    resolve,
    pending: () => activeId,
    cancel,
    dispose: () => opts.abortSignal?.removeEventListener("abort", onAbort),
  };
}

/**
 * Settle a prompt that is still in flight when the run ends or aborts.
 * DENY, not abstain: this is the terminal link, and a run that is ending must
 * not execute a command nobody approved.
 */
export async function cancelPendingAsk(link: HumanAskLink): Promise<void> {
  await link.cancel();
}
