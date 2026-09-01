import { beforeEach, describe, expect, test } from "bun:test";
import {
  _authPromptDeps,
  PromptCancelledError,
  type PromptStdin,
  promptForLine,
  promptForSecret,
  promptForSelect,
} from "@/cli/auth-prompt";

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

  test("rejects without touching raw mode when stdin is not a TTY", async () => {
    const h = makeStdin();
    h.stdin.isTTY = false;
    _authPromptDeps.stdin = h.stdin;

    await expect(promptForSecret("API key:")).rejects.toBeInstanceOf(PromptCancelledError);
    expect(h.rawModeCalls).toEqual([]);
  });
});

const ARROW_UP = "\u001b[A";
const ARROW_DOWN = "\u001b[B";

describe("promptForLine onEmptySubmit", () => {
  test("Enter on an empty buffer runs the hook and keeps reading", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    let hits = 0;

    const pending = promptForLine("Paste the code:", () => {
      hits += 1;
    });
    h.emit("data", CR);
    h.emit("data", CR);
    expect(hits).toBe(2);

    h.emit("data", "abc");
    h.emit("data", CR);
    expect(await pending).toBe("abc");
    expect(hits).toBe(2);
  });

  test("Enter on a non-empty buffer submits rather than firing the hook", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    let hits = 0;

    const pending = promptForLine("Paste the code:", () => {
      hits += 1;
    });
    h.emit("data", "x");
    h.emit("data", CR);

    expect(await pending).toBe("x");
    expect(hits).toBe(0);
  });

  test("without a hook an empty Enter still submits", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForLine("Paste the code:");
    h.emit("data", CR);
    expect(await pending).toBe("");
  });
});

describe("promptForSelect", () => {
  const choices = [
    { id: "browser", label: "Browser login (default)" },
    { id: "device_code", label: "Device code login (headless)" },
  ];

  test("Enter picks the first option", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("data", CR);
    expect(await pending).toBe("browser");
  });

  test("arrow down moves the highlight before committing", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("data", ARROW_DOWN);
    h.emit("data", CR);
    expect(await pending).toBe("device_code");
  });

  test("arrow up from the first option wraps to the last", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("data", ARROW_UP);
    h.emit("data", CR);
    expect(await pending).toBe("device_code");
  });

  test("cannot return a value that is not one of the options", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("data", "nonsense");
    h.emit("data", CR);
    expect(choices.map((c) => c.id)).toContain(await pending);
  });

  test("Ctrl+C cancels and restores the terminal", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("data", ETX);
    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(h.rawModeCalls.at(-1)).toBe(false);
  });

  test("Ctrl+D cancels rather than committing the highlighted row", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("data", EOT);
    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("a closed stream cancels", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("end");
    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("rejects when stdin is not a TTY", async () => {
    const h = makeStdin();
    (h.stdin as { isTTY?: boolean }).isTTY = false;
    _authPromptDeps.stdin = h.stdin;
    await expect(promptForSelect("How?", choices)).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("rejects an empty option list rather than picking for the user", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    await expect(promptForSelect("How?", [])).rejects.toBeInstanceOf(PromptCancelledError);
  });

  test("removes its listeners once settled", async () => {
    const h = makeStdin();
    _authPromptDeps.stdin = h.stdin;
    const pending = promptForSelect("How?", choices);
    h.emit("data", CR);
    await pending;
    expect(h.listenerCount("data")).toBe(0);
  });
});
