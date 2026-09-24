/**
 * The ask-tier resolver chain (P2 design section 4).
 *
 * One decision point for every permission adjudicator: the approvals cache,
 * a future classifier (P5) and the human gate are all LINKS here. The channel
 * that asks a human lives in src/interaction/ and is not a peer of this chain
 * -- it is what the human link talks to.
 *
 * Fail-closed by construction: the chain appends its own terminal deny, so an
 * exhausted or all-abstaining chain denies whether or not the last link is
 * total. A link that throws is treated as no answer, never as permission.
 */
import type { AskRequest } from "./types";

/** A link's answer. `abstain` means "no opinion, try the next link". */
export type AskDecision = "allow" | "deny" | "abstain";

/** Who actually decided. Carried into the ledger so it never has to be inferred. */
export type AskDecidedBy = "cache" | "model" | "human" | "timeout" | "unavailable" | "cancelled";

/**
 * Per-ask control (US-003), carried SEPARATELY from the `AskRequest` so the
 * request the ledger records stays the pure request and a resolver can react
 * to the orchestrating turn being cancelled.
 */
export interface AskControl {
  /** The turn's abort signal; aborted while a waiter sits on-screen or queued. */
  readonly signal?: AbortSignal;
  /** Notifies the turn loop that this ask is waiting on a human. */
  readonly onWaiting?: () => void;
}

export interface AskLinkOutcome {
  readonly decision: AskDecision;
  readonly decidedBy: AskDecidedBy;
}

/**
 * One adjudicator. A link ALWAYS names who decided, because a single link can
 * answer for more than one reason -- the human link resolves as `human` when
 * someone taps and as `timeout` when nobody does.
 */
export interface AskLink {
  readonly name: string;
  resolve(req: AskRequest, control?: AskControl): Promise<AskLinkOutcome>;
}

/** What the runtime consumes. Never `abstain`. */
export interface AskVerdict {
  readonly decision: "allow" | "deny";
  readonly decidedBy: AskDecidedBy;
  readonly latencyMs: number;
}

export interface AskResolver {
  /**
   * Whether a human can answer at all (ADR-030, amended for P4): an interaction
   * channel exists for this run. Absent means false. Only the escalate Bash
   * DESCRIPTION reads it; the verdict never depends on it.
   */
  readonly humanReachable?: boolean;
  resolve(req: AskRequest, control?: AskControl): Promise<AskVerdict>;
}

/**
 * Compose links into a resolver. First non-abstain wins.
 *
 * A throwing link abstains rather than propagating: `runtime.callTool` turns an
 * exception out of the resolver into a TOOL ERROR surfaced to the model, not a
 * denial, which would lose the `denied:ask` ledger row and hand the agent
 * something it may retry around.
 */
export function chainAskLinks(links: readonly AskLink[]): AskResolver {
  return {
    async resolve(req: AskRequest): Promise<AskVerdict> {
      const started = Date.now();
      for (const link of links) {
        let outcome: AskLinkOutcome;
        try {
          outcome = await link.resolve(req);
        } catch {
          continue;
        }
        if (outcome.decision === "abstain") continue;
        return { decision: outcome.decision, decidedBy: outcome.decidedBy, latencyMs: Date.now() - started };
      }
      return { decision: "deny", decidedBy: "unavailable", latencyMs: Date.now() - started };
    },
  };
}
