/**
 * Escalation Quote Integrity Check (Issue #930 Part 2)
 *
 * When an implementer or reviewer emits an escalation reason that quotes
 * file content (any string matching `<file>:<line>` followed by a quoted
 * snippet), the harness verifies those quotes against the file at HEAD.
 *
 * Unverified quotes are replaced with `<UNVERIFIED_QUOTE>` so fabricated
 * evidence does not propagate into priorErrors and bias the next-tier agent.
 *
 * This is a lightweight string-search check, not semantic analysis.
 * It catches the "LLM invents a quote to justify its position" failure mode
 * described in Issue #930 Pattern B.
 */

import { getSafeLogger } from "../../logger";
import { validateModulePath } from "../../utils/path-security";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuoteTriple {
  file: string;
  line: number;
  quote: string;
}

/** Injectable deps for testing without touching the filesystem. */
export const _quoteIntegrityDeps = {
  readFile: async (path: string): Promise<string | null> => {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
};

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Pattern: `some/file.ts:42` followed (on the same line) by a quoted snippet
 * in backticks or double-quotes.
 *
 * Capture groups: 1=file, 2=line, 3=backtick-quote, 4=double-quote-quote
 */
export function extractQuoteTriples(reason: string): QuoteTriple[] {
  const re = /([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+):(\d+)[^\n`"]*(?:(?:`([^`\n]{3,120})`)|(?:"([^"\n]{3,120})"))/g;
  const triples: QuoteTriple[] = [];
  for (;;) {
    const match = re.exec(reason);
    if (match === null) break;
    const file = match[1];
    const line = Number.parseInt(match[2], 10);
    const quote = (match[3] ?? match[4] ?? "").trim();
    if (file && !Number.isNaN(line) && quote.length >= 3) {
      triples.push({ file, line, quote });
    }
  }
  return triples;
}

// ─── Verification ─────────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;

/** Collapse whitespace for comparison (mirrors AC quote validator normalisation). */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Verify a single (file, line, quote) triple against the file on disk.
 * Reads workdir/file and checks whether `quote` appears (whitespace-normalised)
 * within ±CONTEXT_LINES of the cited line number.
 */
export async function verifyQuoteTriple(
  triple: QuoteTriple,
  workdir: string,
  deps = _quoteIntegrityDeps,
): Promise<boolean> {
  // BUG-08: triple.file is extracted from LLM-authored (agent-controlled)
  // escalation text via a regex that admits ".." segments. Without
  // containment, a citation like "../../.env:1 `SECRET=x`" would read
  // outside workdir and could get "verified" — evidence from outside the
  // repo influencing the next-tier agent's decision.
  const validated = validateModulePath(triple.file, [workdir]);
  if (!validated.valid || !validated.absolutePath) return false;

  const content = await deps.readFile(validated.absolutePath);
  if (content === null) return false;

  const lines = content.split("\n");
  const start = Math.max(0, triple.line - 1 - CONTEXT_LINES);
  const end = Math.min(lines.length, triple.line + CONTEXT_LINES);
  const window = lines.slice(start, end).join("\n");

  return normalizeWs(window).toLowerCase().includes(normalizeWs(triple.quote).toLowerCase());
}

// ─── Main verifier ────────────────────────────────────────────────────────────

/**
 * Scan an escalation reason for (file, line, quote) citations and verify each
 * against the repo at HEAD.
 *
 * Unverified quotes are replaced with `<UNVERIFIED_QUOTE>` in the returned
 * string. A warning is logged for each substitution so the next-tier agent
 * cannot inherit fabricated evidence.
 *
 * When no citations are found the original reason is returned unchanged.
 */
export async function verifyEscalationQuotes(
  reason: string,
  workdir: string,
  storyId: string,
  deps = _quoteIntegrityDeps,
): Promise<string> {
  const triples = extractQuoteTriples(reason);
  if (triples.length === 0) return reason;

  const logger = getSafeLogger();
  let verified = reason;

  for (const triple of triples) {
    const ok = await verifyQuoteTriple(triple, workdir, deps);
    if (!ok) {
      logger?.warn("escalation", "escalation_quote_unverified — replacing with <UNVERIFIED_QUOTE>", {
        storyId,
        file: triple.file,
        line: triple.line,
        quote: triple.quote.slice(0, 80),
      });
      // Replace only the quoted text; leave the file:line citation so the
      // next-tier agent still knows which locus was contested.
      verified = verified.replaceAll(triple.quote, "<UNVERIFIED_QUOTE>");
    }
  }

  return verified;
}
