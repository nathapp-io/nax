/**
 * InputBox — the ask card's one-line text box.
 *
 * The box is controlled: it owns no text and reports every edit through `onValueChange`, so
 * the card can measure the rows it will draw. Keys the terminal delivers before the owner
 * re-renders arrive in one React batch (a paste, or two keys in one chunk), and both handlers
 * run against the same `value` prop. The box therefore has to reduce the newest text it
 * published rather than the prop it was rendered with, or the second key of a batch silently
 * discards the first — and a Return in that batch submits the text from before the batch.
 *
 * The harness mounts the box under an owner that keeps the value, exactly as `AskPrompt`
 * does, so a submit is observed the way the card observes it.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement, useState } from "react";
import { InputBox, inputBoxRows } from "@/tui/chat/InputBox";

const RETURN = "\r";
const BACKSPACE = "\x7f";
const WIDTH = 20;

afterEach(() => {
  cleanup();
});

interface MountOptions {
  readonly initialValue?: string;
  readonly maxRows?: number;
  readonly busy?: boolean;
}

function mount(options: MountOptions = {}) {
  const { initialValue = "", maxRows, busy = false } = options;
  const changes: string[] = [];
  const onSubmit = mock((_text: string) => {});

  function Owner(): ReactElement {
    const [value, setValue] = useState(initialValue);
    const change = (next: string): void => {
      changes.push(next);
      setValue(next);
    };
    return (
      <InputBox
        busy={busy}
        onSubmit={onSubmit}
        value={value}
        onValueChange={change}
        width={WIDTH}
        {...(maxRows === undefined ? {} : { maxRows })}
      />
    );
  }

  const ui = render(<Owner />);
  const rows = (): string[] => (ui.lastFrame() ?? "").split("\n").map((row) => row.trimEnd());
  const type = (input: string): void => {
    act(() => {
      ui.stdin.write(input);
    });
  };
  /** Several keypresses delivered before the owner can re-render — one React batch. */
  const typeBatch = (...inputs: readonly string[]): void => {
    act(() => {
      for (const input of inputs) ui.stdin.write(input);
    });
  };
  return { ui, changes, onSubmit, rows, type, typeBatch };
}

describe("InputBox batched keys", () => {
  test("keeps every key of one batch, in the order it arrived", () => {
    const box = mount();
    box.typeBatch("a", "b");
    expect(box.changes).toEqual(["a", "ab"]);
    expect(box.rows()).toEqual(["> ab"]);
  });

  test("submits the text typed in the same batch as the return", () => {
    const box = mount();
    box.typeBatch("a", "b");
    box.typeBatch("c", RETURN);
    expect(box.onSubmit).toHaveBeenCalledWith("abc");
  });

  test("backspace in a batch deletes from the batched text, not the rendered one", () => {
    const box = mount();
    box.typeBatch("a", "b", BACKSPACE);
    expect(box.changes).toEqual(["a", "ab", "a"]);
  });

  test("a batch of one key still edits the rendered text", () => {
    const box = mount({ initialValue: "x" });
    box.type("y");
    expect(box.rows()).toEqual(["> xy"]);
  });
});

describe("InputBox drawing", () => {
  test("draws exactly the rows it measures", () => {
    const value = "one\ntwo";
    const box = mount({ initialValue: value });
    expect(box.rows()).toEqual([...inputBoxRows(value, WIDTH)]);
  });

  test("keeps the newest rows of a tall answer inside the row window", () => {
    const value = "a\nb\nc\nd";
    const box = mount({ initialValue: value, maxRows: 2 });
    expect(box.rows()).toEqual([...inputBoxRows(value, WIDTH, 2)]);
    expect(box.rows()).toHaveLength(2);
  });

  test("a busy box does not submit ordinary text", () => {
    const box = mount({ busy: true });
    box.type("help");
    box.type(RETURN);
    expect(box.onSubmit).not.toHaveBeenCalled();
  });

  test("a busy box submits a slash command typed in one batch", () => {
    const box = mount({ busy: true });
    box.typeBatch("/cost", RETURN);
    expect(box.onSubmit).toHaveBeenCalledWith("/cost");
  });
});
