/**
 * CTX-3: bounded tail-read for append-only JSONL scratch files.
 *
 * scratch.jsonl grows for the whole run (every verify/rectify/TDD/lint
 * result), and only the most-recent-N entries are ever rendered. Reading and
 * parsing the entire file on every `fetch()` (multiple times per story) made
 * per-assembly cost grow linearly with run progress. This reads only the
 * last `maxBytes` and drops a possibly-torn first line.
 */

/** Default tail window — generous for the ~20-entry caps callers apply on top. */
export const DEFAULT_JSONL_TAIL_BYTES = 65_536;

export async function readJsonlTail(path: string, maxBytes: number = DEFAULT_JSONL_TAIL_BYTES): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= maxBytes) return file.text();

  const tail = await file.slice(size - maxBytes).text();
  const newlineIndex = tail.indexOf("\n");
  // No newline in the tail window at all — the whole window is one torn
  // line; nothing usable to return.
  return newlineIndex === -1 ? "" : tail.slice(newlineIndex + 1);
}
