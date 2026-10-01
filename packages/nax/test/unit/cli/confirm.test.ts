// L15 (review 2026-08-14): the confirmation prompt registered only a `data`
// listener. Two consequences, both covered here:
//   - a stream that ended or errored before a keypress left the promise pending
//     forever with the terminal still in raw mode
//   - Ctrl+D fell into the "any other input" branch and resolved TRUE. Raw mode
//     does no EOF processing, so the byte arrives as ordinary data, and a
//     keystroke that universally means "cancel" was confirming the run.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _confirmDeps, type ConfirmStdin, promptForConfirmation } from "@/cli";

const ETX = "\u0003";
const EOT = "\u0004";

/** Minimal EventEmitter-ish stdin double that records terminal-state calls. */
function makeStdin(isTTY = true) {
  const listeners = new Map<string, ((chunk: string) => void)[]>();
  const rawModeCalls: boolean[] = [];
  const stdin: ConfirmStdin = {
    isTTY,
    setRawMode: (mode: boolean) => rawModeCalls.push(mode),
    resume: () => undefined,
    pause: () => undefined,
    setEncoding: () => undefined,
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    once: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener as () => void]),
    removeListener: (event, listener) =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== (listener as unknown)),
      ),
  };
  return {
    stdin,
    rawModeCalls,
    emit: (event: string, chunk = "") => {
      for (const l of [...(listeners.get(event) ?? [])]) l(chunk);
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  };
}

describe("promptForConfirmation", () => {
  let original: typeof _confirmDeps.stdin;
  let originalWrite: typeof _confirmDeps.write;
  let originalExit: typeof _confirmDeps.exit;
  let exitCodes: number[];

  beforeEach(() => {
    original = _confirmDeps.stdin;
    originalWrite = _confirmDeps.write;
    originalExit = _confirmDeps.exit;
    exitCodes = [];
    _confirmDeps.write = () => true;
    _confirmDeps.exit = (code: number) => {
      exitCodes.push(code);
    };
  });

  afterEach(() => {
    _confirmDeps.stdin = original;
    _confirmDeps.write = originalWrite;
    _confirmDeps.exit = originalExit;
  });

  test("resolves true without touching the terminal when stdin is not a TTY", async () => {
    const h = makeStdin(false);
    _confirmDeps.stdin = h.stdin;

    expect(await promptForConfirmation("go?")).toBe(true);
    expect(h.rawModeCalls).toEqual([]);
  });

  test.each([
    ["y", true],
    ["Y", true],
    ["\r", true],
    ["n", false],
    ["N", false],
  ])("resolves %o as %o", async (key, expected) => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", key);

    expect(await pending).toBe(expected);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("treats Ctrl+D as cancellation rather than confirmation", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", EOT);

    expect(await pending).toBe(false);
    expect(h.rawModeCalls).toEqual([true, false]);
    // Ctrl+D is not Ctrl+C — it must not take the exit path.
    expect(exitCodes).toEqual([]);
  });

  test("treats Ctrl+C as cancellation and exits 130", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", ETX);

    expect(await pending).toBe(false);
    expect(exitCodes).toEqual([130]);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("resolves false and restores the terminal when stdin ends before a keypress", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("end");

    expect(await pending).toBe(false);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("resolves false and restores the terminal when stdin errors", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("error");

    expect(await pending).toBe(false);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  // BUG-7 regression — raw-mode `data` events can deliver more than one
  // byte per chunk (paste, or `"n" + Enter` coalesced, or escape sequences).
  // The previous `char.toLowerCase() !== "n"` check operated on the whole
  // chunk, so `"n\r".toLowerCase()` was `"n\r"`, which IS not equal to `"n"`,
  // and the prompt confirmed instead of cancelling. See
  // docs/20260816-review-since-0.80.0-canary.3.md (BUG-7).
  test("treats a 'n' + Enter coalesced chunk as cancellation (first-byte check)", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", "n\r");

    expect(await pending).toBe(false);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("treats a 'N' + Enter coalesced chunk as cancellation (first-byte check)", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", "N\r");

    expect(await pending).toBe(false);
  });

  test("treats a multi-byte chunk starting with 'y' as confirmation", async () => {
    // Defensive coverage: a paste starting with 'y' must still confirm —
    // the first-byte check must be symmetric, not biased against non-'n'.
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", "y\r");

    expect(await pending).toBe(true);
  });

  test("detaches every listener and restores raw mode exactly once", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", "y");
    await pending;

    // A late end/error after the answer must not re-enter the settle path.
    h.emit("end");
    h.emit("data", "n");

    expect(h.rawModeCalls).toEqual([true, false]);
    expect(h.listenerCount("data")).toBe(0);
    expect(h.listenerCount("end")).toBe(0);
    expect(h.listenerCount("error")).toBe(0);
  });
});
