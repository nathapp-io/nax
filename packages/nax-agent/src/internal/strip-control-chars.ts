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

/**
 * Removes ESC-initiated and 8-bit (C1) sequences — CSI, OSC and the other ANSI
 * escape forms — and every remaining control character, while leaving normal
 * whitespace (tab, newline, carriage return) untouched.
 */
export function stripControlChars(input: string): string {
  if (!input) return input;
  // ESC-initiated sequences: OSC "\x1b]...BEL-or-ST", CSI "\x1b[...<final-byte>",
  // and any other "\x1b" + single byte (short escapes like \x1bc, \x1b=).
  // The C1 spellings of the same two sequences follow, one ST/BEL-terminated
  // OSC and one CSI, then the strays.
  const withoutEscapes = input
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC/BEL/ST sequence to strip
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL | OSC ... ST
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC (CSI) sequence to strip
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI ... final byte
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC sequence to strip
    .replace(/\x1b[ -~]/g, "") // other short two-byte escapes (ESC + one printable byte, e.g. ESC c, ESC =, ESC 7)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real C1 (8-bit) OSC sequence to strip
    .replace(/\x9d[^\x07\x9c]*(?:\x07|\x9c)/g, "") // 8-bit OSC ... BEL | ST
    .replace(/\x9b[0-9;?]*[ -/]*[@-~]/g, ""); // 8-bit CSI ... final byte
  return withoutEscapes.replace(C0_CONTROL_CHARS_RE, "").replace(C1_CONTROL_CHARS_RE, "");
}
