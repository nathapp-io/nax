/**
 * Settle every `fix-gap` claim against the two facts that can support it, before a review posts or records
 * anything (spec bot-finding-origin US-003).
 *
 * A `fix-gap` finding does not hold readiness, so a claim nothing backs would let a real blocker through.
 * Two facts must back it. The lineage must say a reachable recorded bot push wrote the finding's line — the
 * same fact an asked claim needs, whether or not the review's prompt asked for an origin (US-002). And the
 * bot must own no inline thread for the key: a `fix-gap` finding gets no thread, so an own thread for the
 * key means the finding was posted while it blocked, and re-raising it — even on a line a later fix touched —
 * keeps it blocking until it is fixed or ruled on.
 *
 * A claim either fact does not support reads `pr`, which blocks exactly as it did before origins existed.
 * Nothing here posts, renders or reads git: the caller supplies both facts, and the verdict handed in is
 * never mutated.
 */
import { getLogger } from "@/logger";
import type { PrFinding, PrReviewVerdict } from "@/operations/bot-types";
import type { PostReviewInput } from "./post";
import { findingKey } from "./render";

/** The facts a settlement reads: where the bot's pushes wrote each line, and the keys it owns a thread for. */
interface FindingOriginFacts {
  readonly lineage: PostReviewInput["lineage"];
  readonly ownThreadKeys: ReadonlySet<string>;
}

/**
 * US-003: the verdict with every unsupported `fix-gap` claim read back as `pr`. Findings with any other
 * origin, or none, are unchanged; the returned verdict is a new object and the input keeps its own origins.
 */
export function settleFindingOrigins(verdict: PrReviewVerdict, facts: FindingOriginFacts): PrReviewVerdict {
  return { ...verdict, findings: verdict.findings.map((finding) => settledFinding(finding, facts)) };
}

/** A claim stands only on a line a reachable push wrote, while the bot owns no inline thread for the key. */
function claimStands(key: string, facts: FindingOriginFacts): boolean {
  return facts.lineage?.lineage.has(key) === true && !facts.ownThreadKeys.has(key);
}

/**
 * A `fix-gap` claim that does not stand reads `pr`, and drops the evidence that backed the claim it no
 * longer makes: a `pr` finding states none, and a reader must not see a reason for an origin it does not have.
 */
function settledFinding(finding: PrFinding, facts: FindingOriginFacts): PrFinding {
  if (finding.origin !== "fix-gap") return finding;
  const key = findingKey(finding);
  if (claimStands(key, facts)) return finding;
  getLogger().debug("bot-post", "Fix-gap finding read as pr: no bot push supports its line", { key });
  const { originEvidence: _dropped, ...rest } = finding;
  return { ...rest, origin: "pr" };
}
