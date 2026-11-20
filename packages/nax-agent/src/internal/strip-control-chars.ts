/**
 * SEC-09: strip ANSI/escape sequences and other control characters from
 * agent-controlled or PRD-authored display strings before they reach a
 * terminal renderer.
 *
 * Ink's <Text> does not sanitize its children, and the headless console
 * formatter writes raw strings straight to stdout. A crafted prd.json field
 * (story title, failure reason) or agent output containing ESC (\x1b)
 * sequences can move the cursor, clear the screen, or (via OSC 52) write to
 * the clipboard in a terminal showing the user's session — defense-in-depth
 * against a prompt-injected repo or a malicious PRD, not a primary trust
 * boundary (the LLM already writes code that runs).
 *
 * The repertoire is C0 (0x00-0x1F) plus DEL (0x7F) — excluding tab (\x09),
 * newline (\x0A) and carriage return (\x0D), because display strings are
 * frequently multi-line and stripping those would corrupt legitimate
 * formatting for no security benefit — and the C1 block (0x80-0x9F).
 *
 * C1 is not decoration: a terminal in 8-bit mode reads 0x9B as the CSI
 * introducer and 0x9D as the OSC one, so leaving those bytes in a display
 * string hands back the exact sequence-stripping the 7-bit pass just did
 * (B1). Their sequence bodies go with them, rather than being left behind as
 * text a reader would mistake for content.
 */

// C0 control range 0x00-0x1F and DEL (0x7F), excluding tab (\x09), newline
// (\x0A), and carriage return (\x0D).
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character stripper
const C0_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// The C1 block, as a last pass: it runs after the 8-bit sequences below, so
// what is left here is a stray C1 byte (NEL 0x85, HTS 0x88, a bare introducer).
const C1_CONTROL_CHARS_RE = /[\x80-\x9F]/g;

/** Index just past the OSC body's terminator (BEL, ESC \\ or C1 ST), or -1 when there is none. */
function oscEnd(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x07 || c === 0x9c) return i + 1;
    if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return -1;
}

/** Index just past a CSI sequence whose parameters start at `from`, or -1 when malformed. */
function csiEnd(input: string, from: number): number {
  let i = from;
  while (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x3f) i++;
  while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
  const c = input.charCodeAt(i);
  return c >= 0x40 && c <= 0x7e ? i + 1 : -1;
}

/**
 * Removes ESC-initiated and 8-bit (C1) sequences — CSI (any parameter byte, incl. ':'), OSC (BEL,
 * ESC \\ or C1 ST terminated, either introducer) and short escapes — and every remaining control
 * character, leaving tab, newline and carriage return. Single pass: each byte is scanned a bounded
 * number of times, and once an OSC finds no terminator no later one is searched for.
 */
export function stripControlChars(input: string): string {
  if (!input) return input;
  const scan = { oscOpen: true };
  let out = "";
  let i = 0;
  while (i < input.length) {
    const end = sequenceEnd(input, i, scan);
    if (end >= 0) {
      i = end;
      continue;
    }
    out += input[i];
    i++;
  }
  return out.replace(C0_CONTROL_CHARS_RE, "").replace(C1_CONTROL_CHARS_RE, "");
}

/** End of the escape sequence starting at `i`, or -1 when none starts there. */
function sequenceEnd(input: string, i: number, scan: { oscOpen: boolean }): number {
  const c = input.charCodeAt(i);
  const next = input.charCodeAt(i + 1);
  const esc = c === 0x1b;
  if ((esc && next === 0x5d) || c === 0x9d) {
    if (!scan.oscOpen) return -1;
    const end = oscEnd(input, i + (esc ? 2 : 1));
    if (end < 0) scan.oscOpen = false;
    return end;
  }
  if ((esc && next === 0x5b) || c === 0x9b) return csiEnd(input, i + (esc ? 2 : 1));
  return esc && next >= 0x20 && next <= 0x7e ? i + 2 : -1;
}
