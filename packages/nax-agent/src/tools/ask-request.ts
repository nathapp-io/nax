/**
 * The one-line call description an AskResolver receives, and the reason a
 * `denied:ask` ledger row carries.
 *
 * Summaries are outbound to a human, so they are masked through
 * `maskForPrompt` before they leave the process; a secret that cannot be
 * shown safely withholds the arguments entirely (`unshowable`, review #9).
 */
import {
  ASK_CANCELLED_REASON,
  ASK_DENIED_REASON,
  ASK_NO_CHANNEL_REASON,
  ASK_PROFILE_REASON,
  ASK_TIMEOUT_REASON,
  ASK_UNSHOWABLE_REASON,
  type AskVerdict,
  maskForPrompt,
} from "#src/permissions/index";
import type { ToolScope } from "./types.ts";

/** Ceiling for the one-line call description an AskResolver receives. */
export const MAX_ASK_SUMMARY_CHARS = 200;

export interface AskSummary {
  readonly summary: string;
  /** True when a secret in the arguments could hide shell syntax if masked (review #9). */
  readonly unshowable: boolean;
}

/**
 * One human-readable line describing the call an `ask` rule matched.
 *
 * Built from the scope's DECLARED fields rather than from `JSON.stringify` of
 * the whole input: the input carries a tool's full payload -- file contents on
 * a Write, a commit message, whatever a provider tool takes -- and an
 * AskResolver is by definition an outbound channel to a human. A summary is
 * what approval needs; the payload is what the audit sink already holds.
 */
export function askSummary(tool: string, scope: ToolScope, input: Record<string, unknown>): AskSummary {
  const fields = [scope.commandField, scope.argvField, scope.verbField, ...scope.pathFields];
  const parts = fields.flatMap((field) => {
    if (field === undefined) return [];
    const value = input[field];
    if (typeof value === "string") return [`${field}=${value}`];
    if (Array.isArray(value)) return [`${field}=${value.filter((v) => typeof v === "string").join(" ")}`];
    return [];
  });
  // Mask the FULL line, then cut: cutting first can split a secret so no
  // pattern matches what is left, and the partial secret would go out.
  const masked = maskForPrompt(`${tool} ${parts.join(" ")}`.trim());
  if (!masked.ok) return { summary: `${tool} [arguments withheld: contains a secret]`, unshowable: true };
  return { summary: masked.masked.slice(0, MAX_ASK_SUMMARY_CHARS), unshowable: false };
}

/** The clause `unsandboxedReasonSuffix` renders, before the reason itself. */
const UNSANDBOXED_PREFIX = " -- runs OUTSIDE the sandbox: ";
/** What the suffix says when the model gave no usable reason. */
const NO_REASON = "no reason given";
/** What the suffix says instead of a reason that cannot be shown safely. */
const REASON_WITHHELD = "reason withheld";

/**
 * The reason clause an unsandboxed approval carries (US-004).
 *
 * The reason is model-authored and travels to a human, so it is masked through
 * `maskForPrompt` and cut to `MAX_ASK_SUMMARY_CHARS` — in that order, for the
 * same reason `askSummary` masks before it cuts: cutting first can split a
 * secret so that no pattern matches what is left. A reason whose masked form
 * would hide shell syntax is WITHHELD rather than denying the ask (the command
 * itself is already vetted by `askSummary`); the person still learns the call
 * wants to run outside the sandbox, which is the fact the suffix exists for.
 *
 * A blank or whitespace-only reason takes the SAME fallback as an absent one:
 * the model wrote nothing that could explain anything, and the approver must
 * never be shown the dangling clause the prefix alone renders.
 */
export function unsandboxedReasonSuffix(input: { readonly unsandboxedReason?: unknown }): string {
  const raw = input.unsandboxedReason;
  if (typeof raw !== "string" || raw.trim() === "") return `${UNSANDBOXED_PREFIX}${NO_REASON}`;
  const masked = maskForPrompt(raw);
  if (!masked.ok) return `${UNSANDBOXED_PREFIX}${REASON_WITHHELD}`;
  return `${UNSANDBOXED_PREFIX}${masked.masked.slice(0, MAX_ASK_SUMMARY_CHARS)}`;
}

/**
 * The reason a `denied:ask` ledger row carries, chosen by WHO refused.
 *
 * One constant for every ask denial asserted "no approval channel is
 * configured" even when a human answered (deny) or nobody answered in time
 * (timeout). Those are materially different facts; see ASK_*_REASON.
 */
export function askDenyReason(decidedBy: AskVerdict["decidedBy"]): string {
  if (decidedBy === "timeout") return ASK_TIMEOUT_REASON;
  if (decidedBy === "human") return ASK_DENIED_REASON;
  if (decidedBy === "cancelled") return ASK_CANCELLED_REASON;
  if (decidedBy === "unshowable") return ASK_UNSHOWABLE_REASON;
  if (decidedBy === "profile") return ASK_PROFILE_REASON;
  return ASK_NO_CHANNEL_REASON;
}
