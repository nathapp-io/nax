import type { UserStory } from "../prd";

/**
 * Structured representation of a TEST_EDIT_REASON block emitted by the implementer
 * under one of the three escape valves in CONTRADICTION_ESCAPE_HATCH.
 *
 * The implementer emits this block in plain text; we parse it into a structured
 * record so the autofix cycle can route on it (see runAgentRectificationV2).
 *
 * Currently only `prd_contract` declarations are routed. `lint_only` and
 * `sibling_scope` declarations are parsed for telemetry but not routed.
 */
export interface TestEditDeclaration {
  reason: "prd_contract" | "lint_only" | "sibling_scope";
  /** Test file path, relative to packageDir. Always present (Exception 1, 2, 3 all require FILE/SIBLING_FILE). */
  file: string;
  /** Verbatim signature line from story description or acceptance criteria. Only set for prd_contract. */
  prdQuote?: string;
  /** Pre-edit line of the test, only set for prd_contract. */
  testBefore?: string;
  /** Post-edit line of the test, only set for prd_contract. */
  testAfter?: string;
  /** Lint rule / error summary, only set for lint_only / sibling_scope. */
  finding?: string;
}

const REASON_RE = /^TEST_EDIT_REASON:\s*(prd_contract|lint_only|sibling_scope)\s*$/m;

/**
 * Extract the value of a single key in the same block of TEST_EDIT_REASON lines.
 * Block boundary is a blank line. Returns the trimmed value or null if absent.
 */
function readBlockField(block: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = block.match(re);
  if (!m?.[1]) return null;
  return m[1].trim();
}

/**
 * Strip a single pair of surrounding double-quotes if present.
 * The PRD_QUOTE prompt format wraps quotes; we accept both forms.
 */
function unwrapQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * Parse all TEST_EDIT_REASON blocks from agent output.
 *
 * Block model: each block begins with `TEST_EDIT_REASON: <reason>` and continues
 * until the next blank line. A blank line between blocks is required. Fields outside
 * a block are ignored. Malformed blocks (missing required FILE / SIBLING_FILE)
 * are silently dropped — the agent is expected to retry on the next attempt.
 */
export function parseTestEditDeclarations(output: string): TestEditDeclaration[] {
  const result: TestEditDeclaration[] = [];
  const blocks = output.split(/\n\s*\n/);

  for (const block of blocks) {
    const reasonMatch = block.match(REASON_RE);
    if (!reasonMatch?.[1]) continue;
    const reason = reasonMatch[1] as TestEditDeclaration["reason"];

    if (reason === "prd_contract") {
      const file = readBlockField(block, "FILE");
      const prdQuote = readBlockField(block, "PRD_QUOTE");
      const testBefore = readBlockField(block, "TEST_BEFORE");
      const testAfter = readBlockField(block, "TEST_AFTER");
      if (!file || !prdQuote || !testBefore || !testAfter) continue;
      result.push({
        reason,
        file,
        prdQuote: unwrapQuotes(prdQuote),
        testBefore,
        testAfter,
      });
    } else if (reason === "lint_only") {
      const file = readBlockField(block, "FILE");
      const finding = readBlockField(block, "FINDING");
      if (!file || !finding) continue;
      result.push({ reason, file, finding });
    } else if (reason === "sibling_scope") {
      const file = readBlockField(block, "SIBLING_FILE");
      const finding = readBlockField(block, "FINDING");
      if (!file || !finding) continue;
      result.push({ reason, file, finding });
    }
  }

  return result;
}

/**
 * Collapse all whitespace runs to a single space, strip spaces adjacent to
 * punctuation chars used in type signatures, then trim.
 */
function normaliseWs(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s*([(),<>])\s*/g, "$1")
    .replace(/\s*:\s*/g, ": ")
    .trim();
}

/**
 * Verify that `prdQuote` appears verbatim (whitespace-normalised) in the story's
 * description or any acceptance criterion. This is the only check that gates
 * Exception 2 from CONTRADICTION_ESCAPE_HATCH — without it, the implementer
 * could fabricate a quote and silently bypass test immutability.
 */
export function validatePrdQuote(prdQuote: string, story: UserStory): boolean {
  if (!prdQuote.trim()) return false;
  const needle = normaliseWs(prdQuote);
  const haystack = normaliseWs([story.description, ...story.acceptanceCriteria].join(" "));
  return haystack.includes(needle);
}
