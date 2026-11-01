import { describe, expect, test } from "bun:test";
import { type EscLayer, escHintText, topEscLayer } from "@/tui/chat/esc-layer";

describe("topEscLayer", () => {
  test("US-006 AC-1 keeps the question card on top of the picker, the menus and the turn", () => {
    expect(
      topEscLayer({
        ask: "question",
        askFromSession: true,
        picker: "jobs",
        mentionShown: true,
        menuShown: true,
        turnRunning: true,
      }),
    ).toEqual({ kind: "question", stops: true });
  });

  test("US-006 AC-2 closes a session question without stopping a turn that is not running", () => {
    expect(
      topEscLayer({ ask: "question", askFromSession: true, mentionShown: false, menuShown: false, turnRunning: false }),
    ).toEqual({ kind: "question", stops: false });
  });

  test("US-006 AC-3 does not stop the turn for a host question, even while one runs", () => {
    expect(
      topEscLayer({ ask: "question", askFromSession: false, mentionShown: false, menuShown: false, turnRunning: true }),
    ).toEqual({ kind: "question", stops: false });
  });

  test("US-006 AC-4 puts an approval card and a choice card on the top layer", () => {
    expect(topEscLayer({ ask: "approval", turnRunning: true, picker: "model" })).toEqual({ kind: "approval" });
    expect(topEscLayer({ ask: "choice", mentionShown: true })).toEqual({ kind: "choice" });
  });

  test("US-006 AC-5 draws the picker over the mention picker, the menu and the turn", () => {
    expect(topEscLayer({ picker: "jobs", mentionShown: true, menuShown: true, turnRunning: true })).toEqual({
      kind: "picker",
      picker: "jobs",
    });
  });

  test("US-006 AC-6 makes one menu layer of the mention picker and the slash menu", () => {
    expect(topEscLayer({ mentionShown: true, menuShown: false, turnRunning: true })).toEqual({ kind: "menu" });
    expect(topEscLayer({ mentionShown: false, menuShown: true, turnRunning: false })).toEqual({ kind: "menu" });
  });

  test("US-006 AC-7 falls back to the running turn, and to nothing when no turn runs", () => {
    expect(topEscLayer({ mentionShown: false, menuShown: false, turnRunning: true })).toEqual({ kind: "turn" });
    expect(topEscLayer({ mentionShown: false, menuShown: false, turnRunning: false })).toEqual({ kind: "none" });
  });

  test("reads an unset screen state as nothing drawn and no turn", () => {
    expect(topEscLayer({})).toEqual({ kind: "none" });
  });

  test("treats a question as the host's when the screen does not say whose it is", () => {
    expect(topEscLayer({ ask: "question", turnRunning: true })).toEqual({ kind: "question", stops: false });
  });

  test("answers a card over a mention picker that only draws its diagnostic line", () => {
    expect(topEscLayer({ ask: "approval", mentionShown: false, turnRunning: true })).toEqual({ kind: "approval" });
  });
});

describe("escHintText", () => {
  test("US-006 AC-8 names closing the card, and the stop when esc does both", () => {
    expect(escHintText({ kind: "question", stops: true })).toBe("esc to close and stop");
    expect(escHintText({ kind: "question", stops: false })).toBe("esc to close");
  });

  test("US-006 AC-9 names denying an approval and cancelling a choice", () => {
    expect(escHintText({ kind: "approval" })).toBe("esc to deny");
    expect(escHintText({ kind: "choice" })).toBe("esc to cancel");
  });

  const PICKER_CASES: ReadonlyArray<[EscLayer, string]> = [
    [{ kind: "picker", picker: "model" }, "esc to close model picker"],
    [{ kind: "picker", picker: "resume" }, "esc to close sessions"],
    [{ kind: "picker", picker: "mode" }, "esc to close mode picker"],
    [{ kind: "picker", picker: "effort" }, "esc to close effort picker"],
    [{ kind: "picker", picker: "jobs" }, "esc to close jobs"],
  ];

  test.each(PICKER_CASES)("US-006 AC-10 names the picker of $0 as $1", (layer, expected) => {
    expect(escHintText(layer)).toBe(expected);
  });

  test("US-006 AC-11 names closing the menu, and leaves the turn and nothing to the busy hints", () => {
    expect(escHintText({ kind: "menu" })).toBe("esc to close menu");
    expect(escHintText({ kind: "turn" })).toBeUndefined();
    expect(escHintText({ kind: "none" })).toBeUndefined();
  });
});
