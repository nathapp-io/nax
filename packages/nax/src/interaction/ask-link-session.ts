/**
 * The extracted prompt-session phases of the human ask link (B7 complexity
 * drain). `ask-link.ts` keeps the factory, the serial queue, the `activeId` /
 * `liveSessions` closure state and the `_askLinkDeps` keepalive seam; this
 * file holds the pieces of `runSession` that do not touch any of that
 * closure state.
 *
 * MUTATION CONTRACT (see docs/plans/STATUS-complexity-drain.md §9.3): every
 * function here takes the live `Session` and MUTATES IT IN PLACE — waiters
 * are settled and removed through the same object reference the caller holds,
 * so an error thrown mid-loop still leaves the caller's session fully up to
 * date. Nothing in this file imports `ask-link.ts` at runtime; the only edge
 * back is `import type` for the public `AskChannelResponse` shape, erased at
 * compile time.
 */

import type { AskLinkOutcome, AskRequest } from "@/permissions";
import { getSafeLogger } from "../logger";
import type { AskChannelResponse } from "./ask-link";
import type { InteractionRequest, InteractionStage } from "./types";

/** What the prompt shows: the command with inert secret spans masked (review #9, D18). */
export interface PromptView {
  readonly command: string;
  readonly maskedCount: number;
}

export const maskedFooter = (count: number): string =>
  `${count} secret value(s) masked; the approved command contains them`;

const ALLOW_ONCE = { key: "allow", label: "Allow once" };
const ALLOW_REMEMBER = { key: "allow-remember", label: "Allow + remember" };
const DENY = { key: "deny", label: "Deny" };

/**
 * ONLY these permit. Everything else -- including unrecognised strings from a
 * future or malformed plugin -- denies. An allowlist, never a denylist.
 */
const PERMITS = new Set(["allow", "allow-remember"]);

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
export interface Waiter {
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

export function makeWaiter(): Waiter {
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
export interface Session {
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

export function deny(decidedBy: "human" | "timeout" | "unavailable" | "cancelled" | "unshowable"): AskLinkOutcome {
  return { decision: "deny", decidedBy };
}

/**
 * The approvals cache matches byte-exact on (stage, command), so a call with
 * no command can never be answered from it: remembering one records an entry
 * nothing reads (#2249). Such calls are offered, and granted, allow-once only.
 */
function canRemember(onRemember: ((req: AskRequest) => Promise<void>) | undefined, req: AskRequest): boolean {
  return onRemember !== undefined && req.command !== undefined;
}

/**
 * Settle every still-live waiter with the shared outcome.
 *
 * A waiter that already aborted (and was removed from the set) is gone; a
 * waiter that aborts between snapshot and iteration gets the outcome anyway
 * (it does not matter whether its listener fires before or after settle --
 * both are idempotent on `aborted`).
 */
export function settleWaiters(session: Session, outcome: AskLinkOutcome): void {
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
}

/**
 * Drop the settled session from every key it still occupies. A joined session
 * sits under its (stage, tool, command) key, a command-less one under its
 * unique `\u0001<id>` key; both are swept so `liveSessions` never retains a
 * settled session. The map is the caller's closure state, passed BY REFERENCE
 * and mutated in place.
 */
export function removeSettledSession(liveSessions: Map<string, Session>, session: Session): void {
  for (const [key, current] of liveSessions) {
    if (current === session) liveSessions.delete(key);
  }
}

/** Everything the approval prompt needs that is fixed once `resolve` built its `view`. */
export interface ApprovalPromptInput {
  /** The on-screen prompt id (`session.id`). */
  readonly id: string;
  readonly req: AskRequest;
  readonly view: PromptView;
  readonly featureName: string | undefined;
  readonly storyId: string | undefined;
  readonly stage: InteractionStage | undefined;
  readonly timeoutMs: number;
  /** The remember sink, if any; its presence offers the remember option (`canRemember`). */
  readonly onRemember: ((req: AskRequest) => Promise<void>) | undefined;
}

/** Render the approval `InteractionRequest` dispatched through the chain. */
export function buildApprovalRequest({
  id,
  req,
  view,
  featureName,
  storyId,
  stage,
  timeoutMs,
  onRemember,
}: ApprovalPromptInput): InteractionRequest {
  return {
    id,
    type: "choose",
    featureName: featureName ?? "unknown",
    ...(storyId !== undefined ? { storyId } : {}),
    stage: stage ?? "execution",
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
    options: canRemember(onRemember, req) ? [ALLOW_ONCE, ALLOW_REMEMBER, DENY] : [ALLOW_ONCE, DENY],
    timeout: timeoutMs,
    // Recorded for the message footer only. This link NEVER consults
    // applyFallback: it maps "continue" AND "escalate" to approve.
    fallback: "abort",
    createdAt: Date.now(),
    metadata: { approvalPrompt: true },
  };
}

/**
 * Decide the shared outcome from the prompt's response: timeout denies,
 * only `PERMITS` permits, and an `allow-remember` reply persists the
 * approval before the tool runs.
 */
export async function decideSessionOutcome(
  response: AskChannelResponse,
  req: AskRequest,
  onRemember: ((req: AskRequest) => Promise<void>) | undefined,
): Promise<AskLinkOutcome> {
  if (response.respondedBy === "timeout") {
    return deny("timeout");
  }
  // `action` is declared as InteractionAction ("approve" | "reject" |
  // "choose" | "input" | "skip" | "abort"), but prompt() remaps a
  // choose reply to the OPTION KEY through a cast
  // (src/interaction/chain.ts:135), so at runtime it carries our keys.
  // Widen to string once, here.
  const action: string = response.action;
  if (!PERMITS.has(action)) {
    return deny("human");
  }
  // `opts.onRemember` repeats canRemember's check so the call below narrows.
  if (action === "allow-remember" && canRemember(onRemember, req) && onRemember) {
    // Remembering is AUXILIARY: the human already approved this
    // exact call, so a failed persistence (lock timeout, disk)
    // must not revoke that approval. AWAITED so the approval is
    // recorded before the tool runs (adversarial finding:
    // fire-and-forget let the resolver return allow before the
    // approval was persisted, racing the next same-key call).
    try {
      await onRemember(req);
    } catch (err) {
      getSafeLogger()?.warn("permissions", "[ask] approved call not remembered; allowing anyway", {
        tool: req.tool,
        stage: req.stage,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { decision: "allow", decidedBy: "human" };
}
