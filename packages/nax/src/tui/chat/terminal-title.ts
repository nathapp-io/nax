/**
 * The terminal title, as the sequences the chat screen owns (US-008).
 *
 * A chat left running in a background tab gives no sign that it is still working, so the
 * screen names the project it was opened in and marks the title while a turn runs.
 * `renderChat` saves the title the terminal had (`PUSH_TITLE`), writes `chatTitle` through
 * `setTitleSequence`, rewrites it on every busy change, and restores the saved one
 * (`POP_TITLE`) once, on teardown.
 *
 * Two rules shape the text. The busy marker comes from the theme's glyph set, so an ASCII
 * terminal gets the same information from `*` that a Unicode one gets from `✳`. And the
 * project name is stripped of control characters first: the title travels inside an OSC
 * string, which ends at the first BEL or newline it meets, so a stray control byte would
 * truncate the sequence — and the rest of it would be read as input.
 *
 * Everything here is pure: the strings in, the strings out.
 */
import type { ChatGlyphs } from "./theme";

/** Save the terminal's current title, so `POP_TITLE` can put it back. */
export const PUSH_TITLE = "\u001b[22;0t";

/** Restore the title the terminal had before `PUSH_TITLE`. */
export const POP_TITLE = "\u001b[23;0t";

/** OSC, then "set icon name and window title", then the text, then the string terminator. */
const OSC_TITLE = "\u001b]0;";
const BEL = "\u0007";

/** What the title is about: the app, then the project the chat was opened in. */
const APP_NAME = "nax";
const TITLE_SEPARATOR = " · ";
/** What stands between the busy marker and the title. */
const BUSY_SEPARATOR = " ";

// C0, DEL and C1: any of them ends an OSC string early, so none may reach the terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what is stripped here.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The title as an OSC 0 sequence: the terminal sets its window title when it reads it. */
export function setTitleSequence(text: string): string {
  return `${OSC_TITLE}${text}${BEL}`;
}

/** The project name as the title may carry it: no control characters, nothing else changed. */
function withoutControls(project: string): string {
  return project.replace(CONTROL_CHARACTERS, "");
}

/**
 * The title for the chat's current state: `nax · my-repo` while it is idle, and
 * `✳ nax · my-repo` — the glyph set's own busy marker — while a turn runs.
 */
export function chatTitle(project: string, busy: boolean, glyphs: ChatGlyphs): string {
  const title = `${APP_NAME}${TITLE_SEPARATOR}${withoutControls(project)}`;
  return busy ? `${glyphs.busy}${BUSY_SEPARATOR}${title}` : title;
}
