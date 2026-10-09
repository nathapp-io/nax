import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTerminalAuthInteraction } from "#src/terminal-auth/interaction";
import { _terminalPromptDeps, type PromptStdin } from "#src/terminal-auth/prompt";

const CR = "\r";

function makeStdin() {
  const listeners = new Map<string, ((chunk: string) => void)[]>();
  const stdin: PromptStdin = {
    isTTY: true,
    setRawMode: () => undefined,
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
    emit: (event: string, chunk = "") => {
      for (const l of [...(listeners.get(event) ?? [])]) l(chunk);
    },
  };
}

let written: string[];
let logged: string[];
const realStdin = _terminalPromptDeps.stdin;
const realWrite = _terminalPromptDeps.write;

beforeEach(() => {
  written = [];
  logged = [];
  _terminalPromptDeps.write = (text: string) => {
    written.push(text);
    return true;
  };
});

afterEach(() => {
  _terminalPromptDeps.stdin = realStdin;
  _terminalPromptDeps.write = realWrite;
});

function interaction(opened: string[] = []) {
  return createTerminalAuthInteraction({ log: (t) => logged.push(t), openUrl: (u) => opened.push(u) });
}

describe("createTerminalAuthInteraction", () => {
  test("a secret prompt never echoes", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const pending = interaction().prompt({ type: "secret", message: "API key:" });
    h.emit("data", `sk-9${CR}`);
    expect(await pending).toBe("sk-9");
    expect(written.join("")).not.toContain("sk-9");
  });

  test("text echoes; select returns the option id", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const text = interaction().prompt({ type: "text", message: "Name:" });
    h.emit("data", `work${CR}`);
    expect(await text).toBe("work");
    expect(written.join("")).toContain("work");
    const select = interaction().prompt({
      type: "select",
      message: "Method:",
      options: [
        { id: "oauth", label: "OAuth" },
        { id: "api-key", label: "API key" },
      ],
    });
    h.emit("data", "\u001b[B");
    h.emit("data", CR);
    expect(await select).toBe("api-key");
  });

  test("Enter on an empty manual-code prompt opens the parked auth url once", async () => {
    const h = makeStdin();
    _terminalPromptDeps.stdin = h.stdin;
    const opened: string[] = [];
    const io = interaction(opened);
    io.notify({ type: "auth-url", url: "https://example.test/authorize" });
    const first = io.prompt({ type: "manual-code", message: "Paste the code:" });
    h.emit("data", CR);
    h.emit("data", `A${CR}`);
    expect(await first).toBe("A");
    const second = io.prompt({ type: "manual-code", message: "Paste the code:" });
    h.emit("data", `B${CR}`);
    expect(await second).toBe("B");
    expect(opened).toEqual(["https://example.test/authorize"]);
    expect(logged.join("\n")).toContain("Press Enter to open it in your browser.");
  });

  test("renders device-code, info links and progress events", () => {
    const io = interaction();
    io.notify({ type: "device-code", userCode: "WDJB", verificationUri: "https://example.test/device" });
    io.notify({ type: "info", message: "Docs:", links: [{ label: "Docs", url: "https://example.test/docs" }] });
    io.notify({ type: "info", message: "Plain." });
    io.notify({ type: "progress", message: "Exchanging tokens" });
    const text = logged.join("\n");
    expect(text).toContain("Go to https://example.test/device and enter code WDJB");
    expect(text).toContain("  Docs: https://example.test/docs");
    expect(text).toContain("Plain.");
    expect(text).toContain("Exchanging tokens");
  });

  test("applies the given style", () => {
    const io = createTerminalAuthInteraction({
      log: (t) => logged.push(t),
      style: { accent: (t) => t, dim: (t) => `~${t}~`, bold: (t) => `*${t}*` },
      openUrl: () => undefined,
    });
    io.notify({ type: "progress", message: "Working" });
    io.notify({ type: "device-code", userCode: "C0DE", verificationUri: "https://example.test/d" });
    expect(logged).toContain("~Working~");
    expect(logged.join("\n")).toContain("*C0DE*");
  });
});
