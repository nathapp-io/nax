/**
 * Fenced-code-block detection for markdown scanners.
 *
 * Shared because every markdown parser in the codebase needs the same answer to
 * the same question: is this construct real, or is it an example inside a code
 * fence? Documents that describe markdown contain literal `## Heading` lines,
 * and a parser that treats one as a real heading fabricates structure that is
 * then carried downstream as fact — into a PRD directive in `src/prd`, or into a
 * rule section boundary in `src/context/rules`.
 *
 * Deliberately dependency-free: a lexical scan over lines, no markdown library,
 * no I/O.
 */

/** A fenced code block delimiter (``` or ~~~), with optional info string. */
export const FENCE = /^\s*(?:```|~~~)/;

/**
 * Indices of every line inside a fenced code block, including the delimiter
 * lines themselves.
 *
 * An unterminated fence is treated as running to end-of-document. That is the
 * conservative direction: content after a stray opening fence is ignored rather
 * than parsed as structure.
 */
export function fencedLineIndices(lines: readonly string[]): Set<number> {
  const fenced = new Set<number>();
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (FENCE.test(line)) {
      fenced.add(i);
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced.add(i);
  }
  return fenced;
}
