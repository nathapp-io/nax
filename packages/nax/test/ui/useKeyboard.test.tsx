/**
 * useKeyboard — TUI keyboard shortcuts.
 *
 * Drives real keypresses through `ink-testing-library`'s stdin into a wrapper
 * that mounts only the hook, so each binding is asserted by the action it
 * dispatches rather than by anything App.tsx does with it.
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import type { UserStory } from "@/prd/types";
import { type KeyboardAction, useKeyboard } from "@/tui/hooks/useKeyboard";
import { PanelFocus } from "@/tui/types";

const TAB = "\t";
const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_P = "\x10";
const CTRL_RIGHT_BRACKET = "\x1d";

interface HarnessProps {
  focus?: PanelFocus;
  currentStory?: UserStory;
  disabled?: boolean;
  actions: KeyboardAction[];
}

/** Mounts the hook alone and pushes every dispatched action into `actions`. */
function Harness({ focus = PanelFocus.Stories, currentStory, disabled, actions }: HarnessProps) {
  useKeyboard({
    focus,
    currentStory,
    disabled,
    onAction: (action) => {
      actions.push(action);
    },
  });
  return <Text>ready</Text>;
}

/** Renders the harness, sends `keys`, and returns the actions it dispatched. */
function press(keys: string, props: Omit<HarnessProps, "actions"> = {}): KeyboardAction[] {
  const actions: KeyboardAction[] = [];
  const { stdin, unmount } = render(<Harness {...props} actions={actions} />);
  act(() => {
    stdin.write(keys);
  });
  unmount();
  return actions;
}

describe("useKeyboard — Stories panel focused", () => {
  test("p dispatches PAUSE", () => {
    expect(press("p")).toEqual([{ type: "PAUSE" }]);
  });

  test("a dispatches ABORT", () => {
    expect(press("a")).toEqual([{ type: "ABORT" }]);
  });

  test("q dispatches QUIT", () => {
    expect(press("q")).toEqual([{ type: "QUIT" }]);
  });

  test("? dispatches SHOW_HELP", () => {
    expect(press("?")).toEqual([{ type: "SHOW_HELP" }]);
  });

  test("c dispatches SHOW_COST", () => {
    expect(press("c")).toEqual([{ type: "SHOW_COST" }]);
  });

  test("r dispatches RETRY", () => {
    expect(press("r")).toEqual([{ type: "RETRY" }]);
  });

  test("an uppercase letter dispatches the same action as its lowercase form", () => {
    expect(press("P")).toEqual([{ type: "PAUSE" }]);
  });

  test("Tab dispatches TOGGLE_FOCUS", () => {
    expect(press(TAB)).toEqual([{ type: "TOGGLE_FOCUS" }]);
  });

  test("Esc dispatches CLOSE_OVERLAY", () => {
    expect(press(ESC)).toEqual([{ type: "CLOSE_OVERLAY" }]);
  });

  test("an unrecognized key dispatches nothing", () => {
    expect(press("z")).toEqual([]);
  });
});

describe("useKeyboard — SKIP requires a current story", () => {
  test("s dispatches SKIP carrying the current story id", () => {
    const story = makeStory({ id: "US-007", title: "S", workdir: "." });
    expect(press("s", { currentStory: story })).toEqual([{ type: "SKIP", storyId: "US-007" }]);
  });

  test("s dispatches nothing when no story is running", () => {
    expect(press("s")).toEqual([]);
  });
});

describe("useKeyboard — Ctrl combos (BUG-22)", () => {
  test("Ctrl+C does not fall through to the plain-c SHOW_COST binding", () => {
    expect(press(CTRL_C)).toEqual([]);
  });

  test("Ctrl+P does not fall through to the plain-p PAUSE binding", () => {
    expect(press(CTRL_P)).toEqual([]);
  });
});

describe("useKeyboard — Agent panel focused", () => {
  const agent = { focus: PanelFocus.Agent };

  test("a plain letter is ignored while the Agent panel is focused", () => {
    expect(press("p", agent)).toEqual([]);
  });

  test("Tab is ignored while the Agent panel is focused", () => {
    expect(press(TAB, agent)).toEqual([]);
  });

  test("Esc is ignored while the Agent panel is focused", () => {
    expect(press(ESC, agent)).toEqual([]);
  });

  // Regression: the binding used to test `key.ctrl && input === "]"` only, but Ink
  // reports a real Ctrl+] (0x1d) as this character with key.ctrl === false — it
  // synthesises ctrl for codes 1-26 and "]" is 29 — so ESCAPE_AGENT was
  // unreachable and the Agent panel had no keyboard exit at all.
  test("Ctrl+] escapes back to the Stories panel", () => {
    expect(press(CTRL_RIGHT_BRACKET, agent)).toEqual([{ type: "ESCAPE_AGENT" }]);
  });
});

describe("useKeyboard — disabled", () => {
  test("no key dispatches while disabled", () => {
    expect(press("p", { disabled: true })).toEqual([]);
    expect(press(TAB, { disabled: true })).toEqual([]);
    expect(press(ESC, { disabled: true })).toEqual([]);
  });
});
