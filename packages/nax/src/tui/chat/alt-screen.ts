/**
 * The alternate screen, as the two escape sequences the chat screen owns.
 *
 * A full-screen chat is drawn on the terminal's alternate screen so quitting gives the
 * user back exactly the scrollback they had before they started. `renderChat` writes
 * `ENTER_ALT_SCREEN` before its first frame and `LEAVE_ALT_SCREEN` once — on unmount, or
 * when the process exits without unmounting (US-019).
 */

/** Switch to the alternate screen and home the cursor, so the first frame starts at 1:1. */
export const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[H";

/** Switch back to the normal screen, leaving the shell prompt where the chat found it. */
export const LEAVE_ALT_SCREEN = "\u001b[?1049l";
