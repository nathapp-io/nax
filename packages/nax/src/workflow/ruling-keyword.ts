import { RULING_SHA_SOURCE } from "@/utils/ruling-sha";
import type { Disposition } from "./decisions-sidecar";

export interface RulingKeyword {
  readonly disposition: Disposition;
  readonly reason: string;
  readonly sha?: string;
}

const FIXED_PATTERN = new RegExp(`^fixed\\s+(${RULING_SHA_SOURCE})(?:\\s*(?:—|-|:)\\s*(.*))?$`, "i");
const REASON_PATTERN = /^(?:waive|waived|override|overridden):\s*(.*)$/i;
const CONFIRM_PATTERN = /^(?:confirm|confirmed)(?::\s*(.*))?$/i;
const VERIFY_PATTERN = /^(?:verify|verified)(?::\s*(.*))?$/i;

/** Parse a ruling keyword from only the first non-empty reply line. */
export function parseRulingKeyword(text: string): RulingKeyword | null {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;

  const fixed = FIXED_PATTERN.exec(line);
  if (fixed) return { disposition: "fixed", sha: fixed[1], reason: fixed[2]?.trim() || "fixed" };

  const reason = REASON_PATTERN.exec(line);
  if (reason) {
    const detail = reason[1].trim();
    if (!detail) return null;
    return { disposition: /^waiv/i.test(line) ? "waived" : "overridden", reason: detail };
  }

  const confirmed = CONFIRM_PATTERN.exec(line);
  if (confirmed) return { disposition: "confirmed", reason: confirmed[1]?.trim() || "confirmed" };

  const verified = VERIFY_PATTERN.exec(line);
  if (verified) return { disposition: "verified", reason: verified[1]?.trim() || "verified" };

  return null;
}
