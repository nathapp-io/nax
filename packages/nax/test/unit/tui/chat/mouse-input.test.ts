import { afterEach, describe, expect, mock, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  createMouseInput,
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  type MouseEvent,
  type MouseInput,
  parseSgrMouse,
} from "@/tui/chat/mouse-input";

const ESC = "\u001b";
const wheel = `${ESC}[<64;3;4M`;
const inputs: MouseInput[] = [];
afterEach(() => {
  for (const input of inputs) input.dispose();
  inputs.length = 0;
});

function setup(isTTY = true) {
  const source = Object.assign(new PassThrough(), {
    isTTY,
    isRaw: false,
    setRawMode: mock((_mode: boolean) => source),
    ref: mock(() => source),
    unref: mock(() => source),
  });
  const input = createMouseInput(source);
  inputs.push(input);
  const events: MouseEvent[] = [];
  input.events.subscribe((event) => events.push(event));
  return { source, input, events };
}

function readText(input: MouseInput): string {
  return input.stdin.read()?.toString() ?? "";
}

describe("parseSgrMouse", () => {
  test.each([
    ["AC-1", "0;10;5M", { kind: "press", button: "left", x: 10, y: 5 }],
    ["AC-2", "0;10;5m", { kind: "release", button: "left", x: 10, y: 5 }],
    ["AC-3", "32;11;5M", { kind: "drag", button: "left", x: 11, y: 5 }],
    ["AC-4", "35;11;5M", { kind: "move", button: "none", x: 11, y: 5 }],
    ["AC-5", "64;3;4M", { kind: "wheelUp", button: "none", x: 3, y: 4 }],
    ["AC-6", "65;3;4M", { kind: "wheelDown", button: "none", x: 3, y: 4 }],
    ["AC-7", "16;3;4M", { kind: "press", button: "left", x: 3, y: 4 }],
    ["AC-8", "x;3;4M", undefined],
  ] satisfies [string, string, MouseEvent | undefined][])("%s parses a complete report", (_ac, sequence, expected) => {
    expect(parseSgrMouse(`${ESC}[<${sequence}`)).toEqual(expected);
  });
  test.each([
    "",
    "a",
    `${wheel}x`,
    `${wheel}\n`,
    `${wheel}${wheel}`,
    `${ESC}[<0;1`,
    `${ESC}[<66;3;4M`,
    `${ESC}[<67;3;4M`,
  ])("rejects non-events %j", (sequence) => {
    expect(parseSgrMouse(sequence)).toBeUndefined();
  });
  test.each([
    [1, "middle"],
    [2, "right"],
    [3, "none"],
    [28, "left"],
  ] satisfies [number, MouseEvent["button"]][])("decodes button and modifiers %s", (bits, button) => {
    expect(parseSgrMouse(`${ESC}[<${bits};1;2M`)).toEqual({ kind: "press", button, x: 1, y: 2 });
  });
});

describe("createMouseInput", () => {
  test("AC-9 strips a report between keys", () => {
    const { source, input } = setup();
    source.write(`a${wheel}b`);
    expect(readText(input)).toBe("ab");
  });
  test("AC-10 emits exactly one wheelUp", () => {
    const { source, events } = setup();
    source.write(`a${wheel}b`);
    expect(events).toEqual([{ kind: "wheelUp", button: "none", x: 3, y: 4 }]);
  });
  test("AC-11 holds and strips split reports", () => {
    const { source, input } = setup();
    source.write(`${ESC}[<0;10`);
    expect(input.stdin.read()).toBeNull();
    source.write(";5M");
    expect(input.stdin.read()).toBeNull();
  });
  test("AC-12 emits one event after completing a split report", () => {
    const { source, events } = setup();
    source.write(`${ESC}[<0;10`);
    expect(events).toEqual([]);
    source.write(";5M");
    expect(events).toEqual([{ kind: "press", button: "left", x: 10, y: 5 }]);
  });
  test.each([
    ["AC-13", ESC],
    ["AC-22", `${ESC}[`],
  ])("%s forwards Escape immediately", (_ac, chunk) => {
    const { source, input } = setup();
    source.write(chunk);
    expect(readText(input)).toBe(chunk);
  });
  test("AC-14 forwards malformed reports without events", () => {
    const { source, input, events } = setup();
    const malformed = `${ESC}[<x;1;1M`;
    source.write(malformed);
    expect(readText(input)).toBe(malformed);
    expect(events).toEqual([]);
  });
  test("AC-15 consumes horizontal wheels without events", () => {
    const { source, input, events } = setup();
    source.write(`${ESC}[<66;3;4M`);
    expect(input.stdin.read()).toBeNull();
    expect(events).toEqual([]);
  });
  test("AC-16 preserves split UTF-8", () => {
    const { source, input } = setup();
    source.write(Buffer.from([0xc3]));
    expect(input.stdin.read()).toBeNull();
    source.write(Buffer.from([0xa9]));
    expect(readText(input)).toBe("é");
  });
  test("AC-17 setEncoding makes read return strings", () => {
    const { source, input } = setup();
    input.stdin.setEncoding("utf8");
    source.write("text");
    expect(input.stdin.read()).toBe("text");
  });
  test("AC-18 forwards raw mode", () => {
    const { source, input } = setup();
    input.stdin.setRawMode(true);
    expect(source.setRawMode).toHaveBeenCalledWith(true);
  });
  test.each([true, false])("AC-19 mirrors source isTTY %s", (isTTY) => {
    const { source, input } = setup(isTTY);
    expect(input.stdin.isTTY).toBe(source.isTTY);
  });
  test("AC-20 unsubscribed listeners receive no more events", () => {
    const { source, input } = setup();
    const listener = mock();
    const unsubscribe = input.events.subscribe(listener);
    source.write(wheel);
    unsubscribe();
    source.write(wheel);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  test("AC-21 dispose detaches the source and stops events", () => {
    const { source, input, events } = setup();
    input.dispose();
    input.dispose();
    expect(source.listenerCount("data")).toBe(0);
    source.write(wheel);
    expect(events).toEqual([]);
  });
  test("forwards ref and unref with chainable adapter returns", () => {
    const { source, input } = setup();
    expect(input.stdin.ref()).toBe(input.stdin);
    expect(input.stdin.unref()).toBe(input.stdin);
    expect(source.ref).toHaveBeenCalledTimes(1);
    expect(source.unref).toHaveBeenCalledTimes(1);
  });
  test("delivers reports and subscriptions in order", () => {
    const { source, input, events } = setup();
    const order: string[] = [];
    input.events.subscribe((event) => order.push(`first:${event.kind}`));
    input.events.subscribe((event) => order.push(`second:${event.kind}`));
    source.write(`${wheel}${ESC}[<65;3;4M${ESC}[<0;1;2m`);
    expect(events.map((event) => event.kind)).toEqual(["wheelUp", "wheelDown", "release"]);
    expect(order).toEqual([
      "first:wheelUp",
      "second:wheelUp",
      "first:wheelDown",
      "second:wheelDown",
      "first:release",
      "second:release",
    ]);
  });
  test("forwards broken partial grammar immediately and recovers", () => {
    const { source, input, events } = setup();
    source.write(`${ESC}[<0;`);
    source.write(`x${wheel}z`);
    expect(readText(input)).toBe(`${ESC}[<0;xz`);
    expect(events).toHaveLength(1);
  });
  test.each([`${ESC}[<`, `${ESC}[<0;`, `${ESC}[<0;1;`])(
    "bounds unterminated numeric fields starting with %j and recovers",
    (prefix) => {
      const { source, input, events } = setup();
      // The adapter retains at most 64 characters of a partial report.
      const partial = prefix + "1".repeat(64 - prefix.length);
      source.write(partial);
      expect(input.stdin.read()).toBeNull();
      source.write("1");
      expect(readText(input)).toBe(`${partial}1`);
      expect(events).toEqual([]);
      source.write(`23${wheel}z`);
      expect(readText(input)).toBe("23z");
      expect(events).toEqual([{ kind: "wheelUp", button: "none", x: 3, y: 4 }]);
    },
  );
  test("forwards an oversized unterminated report in a single chunk", () => {
    const { source, input, events } = setup();
    const oversized = `${ESC}[<${"1".repeat(10_000)}`;
    source.write(oversized);
    expect(readText(input)).toBe(oversized);
    expect(events).toEqual([]);
  });
  test("completes a report at the partial-buffer boundary", () => {
    const { source, input, events } = setup();
    const prefix = `${ESC}[<0;1;`;
    const partial = `${prefix}${"0".repeat(64 - prefix.length - 1)}5`;
    source.write(partial);
    expect(input.stdin.read()).toBeNull();
    source.write("M");
    expect(input.stdin.read()).toBeNull();
    expect(events).toEqual([{ kind: "press", button: "left", x: 1, y: 5 }]);
  });
  test("exports any-motion SGR enable and reverse-order disable sequences", () => {
    expect(ENABLE_MOUSE).toBe(`${ESC}[?1003h${ESC}[?1006h`);
    expect(DISABLE_MOUSE).toBe(`${ESC}[?1006l${ESC}[?1003l`);
  });
});
