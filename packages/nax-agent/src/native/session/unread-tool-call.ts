/**
 * US-006 — naming the tool an unread `<tool_call>` block got wrong.
 *
 * The native loop's `before_turn_end` follow-up used to list every declared
 * tool name and say nothing about the name the model actually wrote, which is
 * the one fact a model that mistyped a call needs. This module recovers that
 * name from the reply text and finds the declared name nearest to it, WITHOUT
 * executing anything: the model still has to make the call itself.
 *
 * Extraction is deliberately shallow (US-006 scope). The block is not parsed as
 * JSON — a half-streamed or malformed block is exactly the case this answers —
 * so the name is the first `"name"` string value in the block, even when it
 * sits inside `arguments`, and when there is no such value it is the bare word
 * the block opens with (`<tool_call>\nGrep\n…`). Anything that does not read as
 * a tool name (see `TOOL_NAME_PATTERN`) is dropped rather than guessed at, so a
 * block that names nothing never produces a "did you mean" sentence.
 *
 * The suggestion is bounded: `MAX_SUGGEST_DISTANCE` edits of Levenshtein
 * distance, case-insensitive. Beyond that the nearest name is not evidence of
 * what the model meant, and a confident-looking wrong suggestion is worse than
 * naming the mistake alone.
 */

/** How many single-character edits away a declared name may be, inclusive. */
export const MAX_SUGGEST_DISTANCE = 2;

/**
 * What counts as a tool name. Mirrors the shape every provider accepts: a
 * letter or `_` first, then up to 63 more name characters. A reply naming
 * something outside this is not reported as a wrong name — there is nothing to
 * compare it with.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** The run of name characters a bare (non-JSON) block opens with. */
const BARE_NAME_RUN = /^[A-Za-z0-9_.-]+/;

/** The first `"name"` string value in a block, JSON-adjacent spacing allowed. */
const NAME_VALUE = /"name"\s*:\s*"([^"]*)"/;

const TOOL_CALL_MARKER = "<tool_call>";
const TOOL_CALL_END = "</tool_call>";

/** Tool names written in the <tool_call> blocks of an assistant reply, first-seen order, no duplicates. */
export function writtenToolNames(content: string): string[] {
  const names: string[] = [];
  for (const block of toolCallBlocks(content)) {
    const name = writtenName(block);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The declared name nearest to `written`, case-insensitive, within MAX_SUGGEST_DISTANCE; first in declared order on a tie. */
export function nearestToolName(written: string, declared: readonly string[]): string | undefined {
  const target = written.toLowerCase();
  let best: { readonly name: string; readonly distance: number } | undefined;
  for (const name of declared) {
    const distance = editDistance(target, name.toLowerCase());
    // Strictly closer only, so an equal distance keeps the earlier declared name.
    if (distance <= MAX_SUGGEST_DISTANCE && (best === undefined || distance < best.distance)) {
      best = { name, distance };
    }
  }
  return best?.name;
}

/**
 * The follow-up the native loop sends for a reply holding an unread tool_call
 * block: the declared names, then one sentence per undeclared name written in
 * the block, with the nearest declared name when there is one.
 */
export function buildUnreadToolCallFollowUp(content: string, declared: readonly string[]): string {
  const sentences = [declaredNamesSentence(declared)];
  for (const written of writtenToolNames(content)) {
    if (!declared.includes(written)) sentences.push(undeclaredSentence(written, declared));
  }
  return sentences.join(" ");
}

/** The follow-up text every reply with an unread block has always received. */
function declaredNamesSentence(declared: readonly string[]): string {
  const names = declared.length > 0 ? declared.join(", ") : "(none)";
  return `Your reply contains a ${TOOL_CALL_MARKER} block that was not run: it did not read as a call of a declared tool. Call tools through the tool interface, using one of these exact names: ${names}.`;
}

/** `` `<written>` is not a declared tool. `` plus the suggestion when a name is near. */
function undeclaredSentence(written: string, declared: readonly string[]): string {
  const nearest = nearestToolName(written, declared);
  const named = `\`${written}\` is not a declared tool`;
  return nearest === undefined ? `${named}.` : `${named}; did you mean \`${nearest}\`?`;
}

/**
 * Every `<tool_call>` body in the text: from a marker to the next
 * `</tool_call>`, or to the end of the text when the block never closes (a
 * reply cut off mid-call is still worth answering). Scanning resumes after the
 * body, so a marker nested inside an open block belongs to that block.
 */
function* toolCallBlocks(content: string): Generator<string> {
  let from = 0;
  for (;;) {
    const start = content.indexOf(TOOL_CALL_MARKER, from);
    if (start < 0) return;
    const bodyStart = start + TOOL_CALL_MARKER.length;
    const close = content.indexOf(TOOL_CALL_END, bodyStart);
    const bodyEnd = close < 0 ? content.length : close;
    yield content.slice(bodyStart, bodyEnd);
    from = bodyEnd;
  }
}

/**
 * The tool name a block wrote, or undefined when it wrote none this module can
 * recognise. A block with a `"name"` string value is judged by that value
 * alone: it is what the model meant to call, so a value that is not a tool name
 * yields no name rather than falling through to the bare-word reading.
 */
function writtenName(block: string): string | undefined {
  const value = NAME_VALUE.exec(block);
  if (value !== null) return isToolName(value[1]) ? value[1] : undefined;
  // Bare form. TOOL_NAME_PATTERN already requires a letter or `_` first, so a
  // run that fails it — a digit, `.` or `-` first, or over 64 characters — is
  // dropped by the same check the JSON form uses.
  const run = BARE_NAME_RUN.exec(block.trimStart())?.[0];
  return run !== undefined && isToolName(run) ? run : undefined;
}

function isToolName(candidate: string): boolean {
  return TOOL_NAME_PATTERN.test(candidate);
}

/**
 * Levenshtein distance, over lowercase forms at the call site. Two rows of the
 * matrix are kept rather than all of it: the names compared are short and the
 * declared list is walked once.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitute);
    }
    previous = current;
  }
  return previous[b.length];
}
