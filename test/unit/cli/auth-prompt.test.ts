import { beforeEach, describe, expect, test } from "bun:test";
import { _authPromptDeps, PromptCancelledError, type PromptStdin, promptForSecret } from "@/cli/auth-prompt";

const ETX = "\u0003";
const EOT = "\u0004";
const BACKSPACE = "\u007F";
const CR = "\r";

function makeStdin() {
  const listeners = new Map<string, ((chunk: string) => void)[]>();
  const rawModeCalls: boolean[] = [];
  const stdin: PromptStdin = {
    isTTY: true,
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

let written: string[];

beforeEach(() => {
  written = [];
  _authPromptDeps.write = (text: string) => {
    written.push(text);
    return true;
  };
});

describe("promptForSecret", () => {
  test("returns the typed value and never echoes it", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "s");
    h.emit("data", "k");
    h.emit("data", "-");
    h.emit("data", "1");
    h.emit("data", CR);

    expect(await pending).toBe("sk-1");
    expect(written.join("")).not.toContain("sk-1");
    expect(written.join("")).not.toContain("sk");
  });

  test("restores raw mode exactly once, on the submit path", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "x");
    h.emit("data", CR);
    await pending;

    expect(h.rawModeCalls).toEqual([true, false]);
    expect(h.listenerCount("data")).toBe(0);
  });

  test("rejects on Ctrl+C", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", ETX);

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("rejects on Ctrl+D rather than submitting a partial secret", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "s");
    h.emit("data", EOT);

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("rejects rather than hanging when the stream ends", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("end");

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(h.rawModeCalls).toEqual([true, false]);
  });

  test("rejects rather than hanging when the stream errors", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("error");

    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("handles backspace without echoing", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;

    const pending = promptForSecret("API key:");
    h.emit("data", "a");
    h.emit("data", "b");
    h.emit("data", BACKSPACE);
    h.emit("data", CR);

    expect(await pending).toBe("a");
  });
});
