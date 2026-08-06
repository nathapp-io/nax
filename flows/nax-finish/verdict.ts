/**
 * Turning a reviewer's reply into a deterministic route.
 *
 * Lives outside `nax-finish.flow.ts` for two reasons: the flow file sits within
 * a few lines of the 600-line hard limit, and this is a cohesive unit —
 * `routeReview` consumes exactly what the parsers produce.
 *
 * The central invariant: **no parser here ever throws.** acpx has no node-level
 * retry and no error edge (`AcpNodeDefinition` offers only `prompt`/`parse`;
 * `FlowEdge` is only `to` or `switch`), so a throw inside `parse` fails the node
 * and fails the run — exit 1, no result file, no notification, bypassing the
 * `escalate` node that exists to report precisely this.
 */
import { extractJsonObject } from "acpx/flows";
import type { Finding, ReviewVerdict } from "./types";

/** Fix rounds allowed per loop before escalating. Moved here with `routeReview`. */
export const MAX_FIX_ATTEMPTS = 3;

/**
 * Unparseable reviews tolerated per phase before escalating.
 *
 * One. A reviewer that ignores the JSON contract twice in a row is not going to
 * comply on a third ask, and each review is the most expensive node in the flow
 * (128s and ~4.2M tokens on the run that motivated this).
 */
export const MAX_REPROMPT_ATTEMPTS = 1;

/** How much of an unparseable reply to carry forward — it lands in a PR comment and a Telegram message. */
export const RAW_TAIL_LIMIT = 500;

function tail(text: string): string {
  const t = text.trim();
  return t.length <= RAW_TAIL_LIMIT ? t : `…${t.slice(-(RAW_TAIL_LIMIT - 1))}`;
}

/** Shared happy path: read the object, normalise findings, rewrite empty `proceed` to `clean`. */
function parseVerdictJson(text: string): ReviewVerdict {
  const raw = extractJsonObject(text) as Partial<ReviewVerdict>;
  const findings: Finding[] = Array.isArray(raw.findings) ? raw.findings : [];
  const route = raw.route === "escalate" ? "escalate" : findings.length === 0 ? "clean" : "proceed";
  return { route, findings, escalationReason: raw.escalationReason };
}

/**
 * Parser for `review_spec` / `review_quality`, whose JSON is load-bearing —
 * `findingsOf` reads it and the fix loop is driven by it. An unreadable reply
 * routes to `reprompt` so `routeReview` can ask once more before escalating.
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  try {
    return parseVerdictJson(text);
  } catch {
    return { route: "reprompt", findings: [], raw: tail(text) };
  }
}

/**
 * Parser for the four `fix_*` nodes, whose parsed value nothing reads —
 * `findingsOf` only ever looks at `review_spec`/`review_quality`, and
 * `commitFixNode` decides from git rather than from the model's word.
 *
 * Never routes `reprompt`: the fix nodes have unconditional edges
 * (`fix_spec → commit_spec`), so a reprompt route would have nowhere to go.
 */
export function parseFixVerdict(text: string): ReviewVerdict {
  try {
    return parseVerdictJson(text);
  } catch {
    return { route: "proceed", findings: [] };
  }
}
