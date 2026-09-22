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
export type AskDecidedBy = "cache" | "model" | "human" | "timeout" | "unavailable";

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
  resolve(req: AskRequest): Promise<AskLinkOutcome>;
}

/** What the runtime consumes. Never `abstain`. */
export interface AskVerdict {
  readonly decision: "allow" | "deny";
  readonly decidedBy: AskDecidedBy;
  readonly latencyMs: number;
}

export interface AskResolver {
  resolve(req: AskRequest): Promise<AskVerdict>;
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
