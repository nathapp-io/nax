/**
 * US-007: a mouse report split *before* its `ESC-[<` prefix is complete must not reach Ink as a
 * lone Escape. The adapter holds a trailing `ESC` or `ESC-[` for `ESC_FLUSH_MS` and flushes it
 * alone, so a real Esc press is still delivered — 50 ms later. Timers come from the module's
 * `_mouseInputDeps` seam, driven here by a virtual clock rather than a real wait.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import { fakeTimers, makeFakeClock } from "@test/helpers";
import {
  _mouseInputDeps,
  createMouseInput,
  ESC_FLUSH_MS,
  type MouseEvent,
  type MouseInput,
} from "@/tui/chat/mouse-input";

const ESC = "\u001b";

const inputs: MouseInput[] = [];
let savedSetTimeout = _mouseInputDeps.setTimeout;
let savedClearTimeout = _mouseInputDeps.clearTimeout;

beforeEach(() => {
  savedSetTimeout = _mouseInputDeps.setTimeout;
  savedClearTimeout = _mouseInputDeps.clearTimeout;
});

afterEach(() => {
  for (const input of inputs) input.dispose();
  inputs.length = 0;
  _mouseInputDeps.setTimeout = savedSetTimeout;
  _mouseInputDeps.clearTimeout = savedClearTimeout;
});

/** A mouse input over a PassThrough source, with the flush timer on a virtual clock. */
function setup() {
  const clock = makeFakeClock();
  const source = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: mock((_mode: boolean) => source),
    ref: mock(() => source),
    unref: mock(() => source),
  });
  Object.assign(_mouseInputDeps, fakeTimers(clock));
  const input = createMouseInput(source);
  inputs.push(input);
  const events: MouseEvent[] = [];
  input.events.subscribe((event) => events.push(event));
  return { clock, source, input, events };
}

function readText(input: MouseInput): string {
  return input.stdin.read()?.toString() ?? "";
}

describe("createMouseInput — a split ESC prefix is not an Esc", () => {
  test("AC-1: ESC then [<0;10;5M before the flush emits one left press at 10,5", () => {
    const { source, events } = setup();
    source.write(ESC);
    source.write("[<0;10;5M");
    expect(events).toEqual([{ kind: "press", button: "left", x: 10, y: 5 }]);
  });

  test("AC-2: ESC then [<0;10;5M before the flush forwards no text", () => {
    const { source, input } = setup();
    source.write(ESC);
    expect(readText(input)).toBe("");
    source.write("[<0;10;5M");
    expect(readText(input)).toBe("");
  });

  test("AC-3: ESC-[ then <35;3;4M before the flush emits one move", () => {
    const { source, events } = setup();
    source.write(`${ESC}[`);
    source.write("<35;3;4M");
    expect(events).toEqual([{ kind: "move", button: "none", x: 3, y: 4 }]);
  });

  test("AC-4: ESC-[ then <35;3;4M before the flush forwards no text", () => {
    const { source, input } = setup();
    source.write(`${ESC}[`);
    expect(readText(input)).toBe("");
    source.write("<35;3;4M");
    expect(readText(input)).toBe("");
  });

  test("AC-5: a lone ESC with no further data forwards nothing before the flush", () => {
    const { source, input } = setup();
    source.write(ESC);
    expect(readText(input)).toBe("");
  });

  test("AC-6: a lone ESC is forwarded once the flush timer runs", async () => {
    const { clock, source, input } = setup();
    source.write(ESC);
    await clock.advance(ESC_FLUSH_MS);
    expect(readText(input)).toBe(ESC);
  });

  test("AC-7: ESC then x before the flush forwards ESC-x", () => {
    const { source, input } = setup();
    source.write(ESC);
    source.write("x");
    expect(readText(input)).toBe(`${ESC}x`);
  });

  test("AC-8: ESC then x before the flush leaves no flush pending", async () => {
    const { clock, source, input } = setup();
    source.write(ESC);
    source.write("x");
    expect(readText(input)).toBe(`${ESC}x`);
    expect(clock.pending()).toBe(0);
    await clock.advance(ESC_FLUSH_MS);
    expect(readText(input)).toBe("");
  });

  test("AC-9: one chunk holding a whole report between keys forwards ab", () => {
    const { source, input } = setup();
    source.write(`a${ESC}[<0;1;1Mb`);
    expect(readText(input)).toBe("ab");
  });

  test("AC-10: one chunk holding a whole report emits one event", () => {
    const { source, events } = setup();
    source.write(`a${ESC}[<0;1;1Mb`);
    expect(events).toEqual([{ kind: "press", button: "left", x: 1, y: 1 }]);
  });

  test("AC-11: dispose drops a held ESC, so the flush forwards nothing", async () => {
    const { clock, source, input } = setup();
    source.write(ESC);
    input.dispose();
    await clock.advance(ESC_FLUSH_MS);
    expect(readText(input)).toBe("");
    expect(clock.pending()).toBe(0);
  });

  test("holds an ESC prefix for exactly 50 ms", () => {
    expect(ESC_FLUSH_MS).toBe(50);
  });
});
