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
  ASK_TIMEOUT_REASON,
  ASK_UNSHOWABLE_REASON,
  type AskVerdict,
  maskForPrompt,
} from "@/permissions";
import type { ToolScope } from "./types";

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
  return ASK_NO_CHANNEL_REASON;
}
