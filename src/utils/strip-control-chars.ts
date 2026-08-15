/**
 * SEC-09: strip ANSI/escape sequences and other C0 control characters from
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
 */

// C0 control range 0x00-0x1F and DEL (0x7F), excluding tab (\x09), newline
// (\x0A), and carriage return (\x0D) — display strings are frequently
// multi-line and stripping those would corrupt legitimate formatting for no
// security benefit.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character stripper
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Removes ESC-initiated sequences (CSI, OSC, and other ANSI escape forms)
 * and other C0 control characters, while leaving normal whitespace
 * (tab, newline, carriage return) untouched.
 */
export function stripControlChars(input: string): string {
  if (!input) return input;
  // ESC-initiated sequences: OSC "\x1b]...BEL-or-ST", CSI "\x1b[...<final-byte>",
  // and any other "\x1b" + single byte (short escapes like \x1bc, \x1b=).
  const withoutEscapes = input
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC/BEL/ST sequence to strip
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL | OSC ... ST
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC (CSI) sequence to strip
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI ... final byte
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a real ESC sequence to strip
    .replace(/\x1b[ -~]/g, ""); // other short two-byte escapes (ESC + one printable byte, e.g. ESC c, ESC =, ESC 7)
  return withoutEscapes.replace(CONTROL_CHARS_RE, "");
}
