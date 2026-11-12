/**
 * US-005 — the chat's keyboard block and its resource summary line.
 *
 * Two pure texts behind `/help`: the terminal controls the chat actually implements, and the
 * one-line catalog summary. The block is pinned word for word here — every other help test
 * composes its expectation from the exported constant, so this is the file that says what the
 * constant must be. The summary is pinned for the empty catalog (no line at all) and for the
 * singular/plural pairs a one-command or one-skill catalog produces.
 */
import { describe, expect, test } from "bun:test";
import { CHAT_KEYBOARD_HELP, resourceHelp } from "@/tui/chat/help-text";

/**
 * The block as the feature spec writes it. A literal on purpose: this is the assertion every
 * other help test defers to, so comparing the constant to itself would assert nothing.
 */
const TARGET_KEYBOARD_HELP = [
  "Keyboard",
  "enter  send · shift+enter / alt+enter  newline",
  "pgup/pgdn  scroll page · shift+up/down  scroll line · home/end  top/latest",
  "ctrl+o  expand/collapse details · ctrl+g  jobs",
  "shift+tab  cycle mode · ctrl+t  cycle reasoning effort",
  "ctrl+v  paste image · esc  close overlay or interrupt turn",
  "ctrl+b  move the running command to the background (ctrl+b ctrl+b in tmux)",
  "ctrl+c  quit when idle; interrupt when running (again to quit)",
  "ctrl+s  steer the running turn (or interrupt and send)",
].join("\n");

describe("CHAT_KEYBOARD_HELP", () => {
  test("AC-1 is the nine-line block the spec fixes, joined with newlines", () => {
    expect(CHAT_KEYBOARD_HELP).toBe(TARGET_KEYBOARD_HELP);
  });

  test("names the nine rows the block has, Keyboard first", () => {
    const rows = CHAT_KEYBOARD_HELP.split("\n");
    expect(rows).toHaveLength(9);
    expect(rows[0]).toBe("Keyboard");
  });
});

describe("resourceHelp", () => {
  test("AC-2 an empty catalog has no summary line at all", () => {
    expect(resourceHelp(0, 0)).toBeUndefined();
  });

  test("AC-3 one command and two skills are both singular and plural as they count", () => {
    expect(resourceHelp(1, 2)).toBe("1 command · 2 skills — type / to search; /skills for details");
  });

  test("AC-4 three commands and one skill keep the plural command and singular skill", () => {
    expect(resourceHelp(3, 1)).toBe("3 commands · 1 skill — type / to search; /skills for details");
  });

  test("a catalog with skills only still has a summary line", () => {
    expect(resourceHelp(0, 1)).toBe("0 commands · 1 skill — type / to search; /skills for details");
  });

  test("a catalog with commands only still has a summary line", () => {
    expect(resourceHelp(1, 0)).toBe("1 command · 0 skills — type / to search; /skills for details");
  });
});
