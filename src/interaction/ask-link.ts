/**
 * The human link of the ask chain (P2 design 5, 6.5a).
 *
 * An ADAPTER, not a channel: it renders an AskRequest into the interaction
 * subsystem's existing vocabulary and dispatches through the chain every other
 * consumer uses. It adds no plugin and no second prompt path. The import of
 * @/permissions is TYPE-ONLY, so `interaction -> permissions` stays a
 * compile-time edge and permissions remains extractable (master plan D8).
 *
 * The dependency is the narrow structural `AskChannel` rather than
 * `InteractionChain` itself: the link only needs `prompt` and `cancel`, and a
 * narrow boundary keeps test doubles cast-free. `InteractionChain` satisfies it
 * structurally.
 */
import type { AskControl, AskLink, AskLinkOutcome, AskRequest } from "@/permissions";
import { getSafeLogger } from "../logger";
import type { InteractionRequest } from "./types";

/** Headroom under MAX_MESSAGE_CHARS (4000) for the header, reason and footer. */
const MAX_COMMAND_CHARS = 3500;

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

  const deny = (decidedBy: "human" | "timeout" | "unavailable" | "cancelled"): AskLinkOutcome => ({
    decision: "deny",
    decidedBy,
  });

  /**
   * One waiter per `resolve` call. Each one watches its own signal and
   * settles independently when that signal aborts -- that is what makes
   * AC4/AC6/AC7/AC8 possible: same-key resolve calls share the on-screen
   * prompt, but a signal abort cancels only that one waiter.
   */
  interface Waiter {
    settle(outcome: AskLinkOutcome): void;
    done: Promise<AskLinkOutcome>;
    aborted: boolean;
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
  }

  function attachWaiter(session: Session, signal: AbortSignal | undefined): Waiter {
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
        const chain = opts.chain;
        if (chain !== null && chain !== undefined) {
          void chain.cancel(session.id).catch(() => undefined);
        }
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
    session.waiters.add(waiter);
    return waiter;
  }

  /**
   * Drive one session's prompt. Called inside the serial queue, so only
   * one prompt is ever on-screen per run.
   */
  async function runSession(req: AskRequest, session: Session): Promise<void> {
    const chain = opts.chain;
    if (chain === null || chain === undefined) {
      // No channel: every live waiter settles unavailable, none of them
      // are ever prompted.
      for (const w of [...session.waiters]) {
        w.settle(deny("unavailable"));
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
    try {
      const response = await chain.prompt({
        id: session.id,
        type: "choose",
        featureName: opts.featureName ?? "unknown",
        ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
        stage: "execution",
        summary: `${req.tool} - approval required`,
        detail: [
          // A Write/Edit ask carries no command: showing `req.summary` keeps
          // the operator informed about what is being approved instead of an
          // empty code block. The command is still shown verbatim when
          // present.
          ...((req.command ?? "").length > 0 ? ["```", req.command, "```"] : []),
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
      });
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
            // must not revoke that approval. Isolated from the prompt's
            // outcome, so any throw here is ignored.
            try {
              opts.onRemember(req).catch((err) => {
                getSafeLogger()?.warn("permissions", "[ask] approved call not remembered; allowing anyway", {
                  tool: req.tool,
                  stage: req.stage,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            } catch {
              // Same: a sync throw must not revoke the approval.
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
        session.waiters.delete(w);
      }
    } catch {
      // Chain threw: every waiter settles unavailable.
      for (const w of [...session.waiters]) {
        w.settle(deny("unavailable"));
        session.waiters.delete(w);
      }
    } finally {
      session.settled = true;
      // Release the liveSessions slot so the next same-key resolve can
      // build a fresh prompt. The entry stays out of the map (no
      // re-attachment to a settled session is possible), and we drop the
      // reference so GC can reclaim the Waiter set.
      for (const [k, v] of liveSessions) {
        if (v === session) liveSessions.delete(k);
      }
    }
  }

  /**
   * A "live" key is one whose session has been scheduled but has not yet
   * settled. We track this so same-key resolves join the same session
   * (AC6/AC7/AC8). The map is keyed by `${stage}\0${command}`; entries
   * are cleared when the session settles.
   */
  const liveSessions = new Map<string, Session>();

  function resolve(req: AskRequest, control?: AskControl): Promise<AskLinkOutcome> {
    // AC10: an already-aborted signal settles cancelled without joining
    // the queue or prompting at all.
    if (control?.signal?.aborted === true) {
      return Promise.resolve(deny("cancelled"));
    }
    const command = req.command ?? "";
    if (command.length > MAX_COMMAND_CHARS) {
      return Promise.resolve(deny("unavailable"));
    }
    const key = `${req.stage}\u0000${command}`;
    const existing = liveSessions.get(key);
    if (existing !== undefined && !existing.settled) {
      return attachWaiter(existing, control?.signal).done;
    }
    // Schedule a new session on the serial queue. The session lives in
    // `liveSessions` until it settles.
    const session: Session = {
      id: `ask-${Math.random().toString(16).slice(2, 10)}`,
      waiters: new Set(),
      settled: false,
      cancelledOnChain: false,
    };
    liveSessions.set(key, session);
    // Chain onto the queue and ALWAYS clear it, so a throw cannot leave
    // the mutex held and deadlock every later ask in the run.
    queue = queue
      .then(() => runSession(req, session))
      .then(
        () => undefined,
        () => undefined,
      );
    return attachWaiter(session, control?.signal).done;
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
        session.waiters.delete(w);
      }
      session.settled = true;
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
