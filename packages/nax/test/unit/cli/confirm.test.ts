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
  let originalWriteErr: typeof _confirmDeps.writeErr;
  let originalExit: typeof _confirmDeps.exit;
  let exitCodes: number[];

  beforeEach(() => {
    original = _confirmDeps.stdin;
    originalWrite = _confirmDeps.write;
    originalWriteErr = _confirmDeps.writeErr;
    originalExit = _confirmDeps.exit;
    exitCodes = [];
    _confirmDeps.write = () => true;
    _confirmDeps.writeErr = () => true;
    _confirmDeps.exit = (code: number) => {
      exitCodes.push(code);
    };
  });

  afterEach(() => {
    _confirmDeps.stdin = original;
    _confirmDeps.write = originalWrite;
    _confirmDeps.writeErr = originalWriteErr;
    _confirmDeps.exit = originalExit;
  });

  test("resolves true without touching the terminal when stdin is not a TTY", async () => {
    const h = makeStdin(false);
    _confirmDeps.stdin = h.stdin;

    expect(await promptForConfirmation("go?")).toBe(true);
    expect(h.rawModeCalls).toEqual([]);
  });

  // F1: `nax memory compact --json` may write nothing but the document to stdout, so the
  // prompt it asks has to be able to put its own text on stderr instead.
  test("writes its question and its newline to the stderr writer when asked, never to stdout", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;
    const written: string[] = [];
    const writtenErr: string[] = [];
    _confirmDeps.write = (text: string) => {
      written.push(text);
      return true;
    };
    _confirmDeps.writeErr = (text: string) => {
      writtenErr.push(text);
      return true;
    };

    const pending = promptForConfirmation("go?", { channel: "stderr" });
    h.emit("data", "y");

    expect(await pending).toBe(true);
    expect(written).toEqual([]);
    expect(writtenErr.join("")).toContain("go?");
    expect(writtenErr.at(-1)).toBe("\n");
  });

  test("keeps writing to stdout when no channel is named", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;
    const written: string[] = [];
    const writtenErr: string[] = [];
    _confirmDeps.write = (text: string) => {
      written.push(text);
      return true;
    };
    _confirmDeps.writeErr = (text: string) => {
      writtenErr.push(text);
      return true;
    };

    const pending = promptForConfirmation("go?");
    h.emit("data", "y");

    expect(await pending).toBe(true);
    expect(written.join("")).toContain("go?");
    expect(writtenErr).toEqual([]);
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

// ─── the default-no question (B3) ────────────────────────────────────────────
//
// `nax memory compact` and `nax memory mirrors --prune` both advertise `[y/N]`, and both were
// driven through this prompt's default-yes mode: it rendered a second, contradictory `[Y/n]`
// suffix and resolved true for Enter and for any key that was not an `n`. A destructive question
// needs the other shape — only an explicit yes may authorize it.

describe("promptForConfirmation — defaultAnswer no", () => {
  let original: typeof _confirmDeps.stdin;
  let originalWrite: typeof _confirmDeps.write;
  let originalExit: typeof _confirmDeps.exit;
  let written: string[];
  let exitCodes: number[];

  beforeEach(() => {
    original = _confirmDeps.stdin;
    originalWrite = _confirmDeps.write;
    originalExit = _confirmDeps.exit;
    written = [];
    exitCodes = [];
    _confirmDeps.write = (text: string) => {
      written.push(text);
      return true;
    };
    _confirmDeps.exit = (code: number) => {
      exitCodes.push(code);
    };
  });

  afterEach(() => {
    _confirmDeps.stdin = original;
    _confirmDeps.write = originalWrite;
    _confirmDeps.exit = originalExit;
  });

  /** One prompt asked under the default-no mode, and the key that answers it. */
  async function ask(question: string, key: string): Promise<boolean> {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;
    const pending = promptForConfirmation(question, { defaultAnswer: "no" });
    h.emit("data", key);
    return await pending;
  }

  test.each([
    ["y", true],
    ["Y", true],
    ["y\r", true],
    ["\r", false],
    ["n", false],
    ["N", false],
    [" ", false],
    ["\u001b", false],
  ])("resolves %o as %o", async (key, expected) => {
    expect(await ask("Apply? [y/N]", key)).toBe(expected);
  });

  test("renders one suffix: the caller's own [y/N], not a second [Y/n] beside it", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("Apply? [y/N]", { defaultAnswer: "no" });
    h.emit("data", "y");
    await pending;

    expect(written.join("")).not.toContain("[Y/n]");
    expect(written.join("").match(/\[y\/N\]/g)).toHaveLength(1);
  });

  test("appends [y/N] to a question that does not state a default itself", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("Remove 2 mirrors?", { defaultAnswer: "no" });
    h.emit("data", "y");
    await pending;

    expect(written.join("")).toContain("Remove 2 mirrors? [y/N]");
  });

  test("the default-yes question keeps rendering [Y/n]", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("go?");
    h.emit("data", "\r");
    expect(await pending).toBe(true);

    expect(written.join("")).toContain("go? [Y/n]");
  });

  test("refuses on a non-TTY instead of taking an unattended yes", async () => {
    const h = makeStdin(false);
    _confirmDeps.stdin = h.stdin;

    expect(await promptForConfirmation("Apply? [y/N]", { defaultAnswer: "no" })).toBe(false);
    expect(h.rawModeCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  test("Ctrl+C still cancels and exits 130 rather than answering", async () => {
    const h = makeStdin();
    _confirmDeps.stdin = h.stdin;

    const pending = promptForConfirmation("Apply? [y/N]", { defaultAnswer: "no" });
    h.emit("data", ETX);

    expect(await pending).toBe(false);
    expect(exitCodes).toEqual([130]);
    expect(h.rawModeCalls).toEqual([true, false]);
  });
});
