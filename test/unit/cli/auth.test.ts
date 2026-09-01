import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _authDeps } from "@/agents/native/auth";
import { _resetCredentialStore, naxCredentialStore } from "@/agents/native/credentials";
import { _cliAuthDeps, authImportCommand, authListCommand, authLoginCommand, authRmCommand } from "@/cli/auth";
import { _authPromptDeps, type PromptStdin } from "@/cli/auth-prompt";
import { _openUrlDeps } from "@/cli/open-url";

function makeFakeStdin(): { stdin: PromptStdin; emit: (event: string, chunk?: string) => void } {
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

type LoginCallOptions = Parameters<typeof _authDeps.login>[0];

let out: string[];
let promptWritten: string[];
let dir: string;
let extraDirs: string[];
const realLogin = _authDeps.login;
const realAmbient = _authDeps.ambientAuthAvailable;
const realPromptStdin = _authPromptDeps.stdin;
const realPromptWrite = _authPromptDeps.write;
const realLog = _cliAuthDeps.log;
const realIsTTY = _cliAuthDeps.isTTY;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

/** Tracked so afterEach can clean up every source temp dir a test creates. */
function makeTrackedTempDir(prefix: string): string {
  const created = makeTempDir(prefix);
  extraDirs.push(created);
  return created;
}

beforeEach(() => {
  out = [];
  promptWritten = [];
  extraDirs = [];
  dir = makeTempDir("nax-cli-auth-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  _cliAuthDeps.log = (text: string) => out.push(text);
  _cliAuthDeps.isTTY = () => true;
  _authDeps.ambientAuthAvailable = mock(async () => false);
  _authPromptDeps.write = (text: string) => {
    promptWritten.push(text);
    return true;
  };
});

afterEach(() => {
  _authDeps.login = realLogin;
  _authDeps.ambientAuthAvailable = realAmbient;
  _authPromptDeps.stdin = realPromptStdin;
  _authPromptDeps.write = realPromptWrite;
  _cliAuthDeps.log = realLog;
  _cliAuthDeps.isTTY = realIsTTY;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
  for (const extra of extraDirs) cleanupTempDir(extra);
});

describe("authLoginCommand", () => {
  test("refuses without a TTY and names the environment variable path", async () => {
    _cliAuthDeps.isTTY = () => false;
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/environment variable/i);
  });

  test("reports the result as returned, without deriving kind from method", async () => {
    _authDeps.login = mock(async () => ({
      providerId: "openrouter",
      method: "oauth" as const,
      kind: "oauth" as const,
    }));
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("openrouter");
    expect(out.join("\n")).toContain("oauth");
  });

  test("exits 130 with no error output when cancelled", async () => {
    class LoginCancelledError extends Error {
      constructor() {
        super("cancelled");
        this.name = "LoginCancelledError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new LoginCancelledError();
    });
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(130);
    expect(out.join("\n")).not.toMatch(/error|failed/i);
  });

  test("warns, without failing, when the new credential shadows a working env var", async () => {
    _authDeps.login = mock(async () => ({
      providerId: "openrouter",
      method: "api-key" as const,
      kind: "api-key" as const,
    }));
    _authDeps.ambientAuthAvailable = mock(async () => true);
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/takes precedence/i);
  });

  test("routes prompts to the terminal and renders the login events", async () => {
    const h = makeFakeStdin();
    _authPromptDeps.stdin = h.stdin;
    _authDeps.login = mock(async (options: LoginCallOptions) => {
      const { interaction } = options;
      const secret = interaction.prompt({ type: "secret", message: "Paste your API key:" });
      h.emit("data", "sk-1\r");
      await secret;
      const select = interaction.prompt({
        type: "select",
        message: "Pick a method:",
        options: [{ id: "oauth", label: "OAuth" }],
      });
      h.emit("data", "oauth\r");
      await select;
      const text = interaction.prompt({ type: "text", message: "Account name:" });
      h.emit("data", "work\r");
      await text;
      const manual = interaction.prompt({ type: "manual-code", message: "Enter the code:" });
      h.emit("data", "WDJB-MJHT\r");
      await manual;
      interaction.notify({ type: "auth-url", url: "https://example.com/authorize" });
      interaction.notify({
        type: "auth-url",
        url: "https://example.com/authorize",
        instructions: "Paste the verifier back.",
      });
      interaction.notify({
        type: "device-code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://example.com/device",
      });
      interaction.notify({
        type: "info",
        message: "Provider docs:",
        links: [{ label: "Docs", url: "https://example.com/docs" }],
      });
      interaction.notify({ type: "info", message: "No links this time." });
      interaction.notify({ type: "progress", message: "Exchanging tokens" });
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    const code = await authLoginCommand("openrouter");

    const text = out.join("\n");
    expect(code).toBe(0);
    // The select renders through the prompt writer now, not the logger.
    expect(promptWritten.join("")).toContain("Pick a method:");
    expect(promptWritten.join("")).toContain("OAuth");
    expect(text).toContain("Open this URL to continue:");
    expect(text).toContain("https://example.com/authorize");
    // The flow's own instructions are deliberately dropped: pi says a browser
    // "should open", and nothing has opened one at this point.
    expect(text).not.toContain("Paste the verifier back.");
    expect(text).toContain("https://example.com/device");
    expect(text).toContain("WDJB-MJHT");
    expect(text).toContain("Docs: https://example.com/docs");
    expect(text).toContain("No links this time.");
    expect(text).toContain("Exchanging tokens");
    expect(promptWritten.join("")).toContain("Account name:");
    expect(promptWritten.join("")).toContain("Enter the code:");
    expect(text).not.toContain("sk-1");
    expect(promptWritten.join("")).not.toContain("sk-1");
  });

  test("reports a login failure and exits 1", async () => {
    _authDeps.login = mock(async () => {
      throw new Error("provider unreachable");
    });
    const code = await authLoginCommand("openrouter");
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("provider unreachable");
  });
});

describe("authImportCommand", () => {
  test("imports pi entries, reports each outcome, and never the key", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-stored" }));
    const source = join(makeTrackedTempDir("nax-pi-"), "auth.json");
    writeFileSync(
      source,
      JSON.stringify({
        mystery: { type: "wat" },
        openai: { type: "api_key", key: "sk-pi-value" },
        openrouter: { type: "api_key", key: "sk-pi-other" },
      }),
    );

    const code = await authImportCommand({ from: source });

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("mystery");
    expect(text).toContain("openai");
    expect(text).toContain("openrouter");
    expect(text).toContain("imported");
    expect(text).toContain("skipped, already present");
    expect(text).toContain("unsupported credential type");
    expect(text).not.toContain("sk-pi-value");
    expect(text).not.toContain("sk-pi-other");
    expect(await naxCredentialStore().read("openai")).toMatchObject({ kind: "api-key", key: "sk-pi-value" });
  });

  test("says there is nothing to import when the source has no entries", async () => {
    const source = join(makeTrackedTempDir("nax-pi-"), "auth.json");
    writeFileSync(source, "{}");

    const code = await authImportCommand({ from: source });

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/nothing to import/i);
  });

  test("reports a missing source file and exits 1", async () => {
    const source = join(makeTrackedTempDir("nax-pi-"), "absent.json");

    const code = await authImportCommand({ from: source });

    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/no credential file to import/i);
  });
});

describe("authListCommand", () => {
  test("says so when the store is empty", async () => {
    expect(await authListCommand()).toBe(0);
    expect(out.join("\n")).toMatch(/no credentials/i);
  });

  test("prints provider and kind but never the key", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    await authListCommand();
    const text = out.join("\n");
    expect(text).toContain("openrouter");
    expect(text).toContain("api-key");
    expect(text).not.toContain("sk-secret-value");
    expect(text).not.toContain("sk-");
  });

  test("marks a shadowed credential", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    _authDeps.ambientAuthAvailable = mock(async () => true);
    await authListCommand();
    expect(out.join("\n")).toMatch(/shadow/i);
  });

  test("marks an expired OAuth credential", async () => {
    await naxCredentialStore().modify("openai-codex", async () => ({
      kind: "oauth",
      access: "a",
      refresh: "r",
      expires: 1,
    }));
    await authListCommand();
    expect(out.join("\n")).toMatch(/expired/i);
  });
});

describe("authRmCommand", () => {
  test("removes the credential and never claims the user is logged out", async () => {
    await naxCredentialStore().modify("openrouter", async () => ({ kind: "api-key", key: "sk-secret-value" }));
    const code = await authRmCommand("openrouter");

    expect(code).toBe(0);
    expect(await naxCredentialStore().read("openrouter")).toBeUndefined();
    const text = out.join("\n").toLowerCase();
    expect(text).not.toContain("logged out");
    expect(text).not.toContain("log out");
    expect(text).toContain("removed locally");
  });

  test("reports a provider that has no stored credential", async () => {
    expect(await authRmCommand("absent")).toBe(1);
    expect(out.join("\n")).toMatch(/no stored credential/i);
  });
});

describe("authLoginCommand browser handoff", () => {
  test("Enter on the manual-code prompt opens the parked auth url", async () => {
    const h = makeFakeStdin();
    _authPromptDeps.stdin = h.stdin;
    const opened: string[] = [];
    _openUrlDeps.spawn = (command) => {
      opened.push(command[command.length - 1] as string);
    };
    _openUrlDeps.platform = () => "darwin";

    _authDeps.login = mock(async (options: LoginCallOptions) => {
      const { interaction } = options;
      interaction.notify({ type: "auth-url", url: "https://example.com/authorize" });
      const manual = interaction.prompt({ type: "manual-code", message: "Paste the code here:" });
      h.emit("data", "\r");
      h.emit("data", "CODE\r");
      await manual;
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    expect(await authLoginCommand("openrouter")).toBe(0);
    expect(opened).toEqual(["https://example.com/authorize"]);
    expect(out.join("\n")).toContain("Press Enter to open it in your browser.");
    // The flow's own message is passed through verbatim as the prompt.
    expect(promptWritten.join("")).toContain("Paste the code here:");
  });

  test("a second Enter does not launch a second window", async () => {
    const h = makeFakeStdin();
    _authPromptDeps.stdin = h.stdin;
    const opened: string[] = [];
    _openUrlDeps.spawn = (command) => {
      opened.push(command[command.length - 1] as string);
    };
    _openUrlDeps.platform = () => "darwin";

    _authDeps.login = mock(async (options: LoginCallOptions) => {
      const { interaction } = options;
      interaction.notify({ type: "auth-url", url: "https://example.com/authorize" });
      const first = interaction.prompt({ type: "manual-code", message: "Paste it:" });
      h.emit("data", "\r");
      h.emit("data", "A\r");
      await first;
      const second = interaction.prompt({ type: "manual-code", message: "Paste it:" });
      h.emit("data", "B\r");
      await second;
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    expect(await authLoginCommand("openrouter")).toBe(0);
    expect(opened).toEqual(["https://example.com/authorize"]);
  });

  test("with no auth url parked, the manual-code prompt is left alone", async () => {
    const h = makeFakeStdin();
    _authPromptDeps.stdin = h.stdin;
    const opened: string[] = [];
    _openUrlDeps.spawn = (command) => {
      opened.push(command[command.length - 1] as string);
    };

    _authDeps.login = mock(async (options: LoginCallOptions) => {
      const manual = options.interaction.prompt({ type: "manual-code", message: "Paste the code here:" });
      h.emit("data", "CODE\r");
      await manual;
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    expect(await authLoginCommand("openrouter")).toBe(0);
    expect(opened).toEqual([]);
    expect(out.join("\n")).not.toContain("Press Enter to open");
  });

  test("forwards an explicit method to nax-ai without interpreting it", async () => {
    let seen: string | undefined;
    _authDeps.login = mock(async (options: LoginCallOptions & { method?: string }) => {
      seen = options.method;
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    expect(await authLoginCommand("openrouter", "oauth")).toBe(0);
    expect(seen).toBe("oauth");
  });

  test("omits method entirely when none is given, leaving nax-ai to prompt", async () => {
    let hasKey = true;
    _authDeps.login = mock(async (options: LoginCallOptions) => {
      hasKey = "method" in options;
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    expect(await authLoginCommand("openrouter")).toBe(0);
    expect(hasKey).toBe(false);
  });
});
