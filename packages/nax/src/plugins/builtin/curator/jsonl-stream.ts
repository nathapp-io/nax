/**
 * Curator Rollup — shared JSONL line reader.
 *
 * The rollup is one append-only file shared by every project on the machine and
 * is unbounded between `nax curator gc` runs; on a real machine it reached
 * 618 MB / 1.13M rows. Every reader of it must therefore be bounded by what it
 * retains, not by the file — which means never materialising the text or a
 * line array.
 *
 * Takes a `BunFile` rather than a path so callers can stream a `slice()` (the
 * heuristic window reads a tail) through the same reader as a whole file.
 */

/**
 * Yield a JSONL source line by line without materialising it.
 *
 * Resident memory is one chunk plus the carry — a single line — regardless of
 * source size. A final line with no trailing newline is still yielded.
 */
export async function* streamJsonlLines(file: Bun.BunFile): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of file.stream()) {
    carry += decoder.decode(chunk, { stream: true });
    let nl = carry.indexOf("\n");
    while (nl !== -1) {
      yield carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      nl = carry.indexOf("\n");
    }
  }
  carry += decoder.decode();
  if (carry.length > 0) yield carry;
}
