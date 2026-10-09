import { describe, expect, test } from "bun:test";
import {
  AuthCancelledError,
  type AuthInteraction,
  type AuthMethod,
  NaxError,
  PromptCancelledError,
} from "@nathapp/nax-agent";
import { type LoginDeps, runLoginCommand } from "#src/server/login";

const silent: AuthInteraction = { prompt: async () => "", notify: () => undefined };

function deps(overrides: Partial<LoginDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { provider: string; method?: AuthMethod }[] = [];
  const base: LoginDeps = {
    isTTY: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    auth: {
      interaction: () => silent,
      runLogin: async (provider, _interaction, method) => {
        calls.push({ provider, ...(method !== undefined ? { method } : {}) });
        return { providerId: provider, method: method ?? "api-key", kind: "api-key" };
      },
    },
    ...overrides,
  };
  return { deps: base, out, err, calls };
}

describe("runLoginCommand", () => {
  test("logs in, reports the result as returned, exits 0", async () => {
    const h = deps();
    expect(await runLoginCommand({ provider: "anthropic", method: "api-key" }, h.deps)).toBe(0);
    expect(h.calls).toEqual([{ provider: "anthropic", method: "api-key" }]);
    expect(h.out).toEqual(["Signed in to anthropic (method: api-key, credential: api-key)"]);
    expect(h.err).toEqual([]);
  });

  test("refuses at once without a TTY, never prompting (Review Focus 5)", async () => {
    const h = deps({ isTTY: false });
    expect(await runLoginCommand({ provider: "anthropic" }, h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join("\n")).toContain("needs an interactive terminal");
    expect(h.err.join("\n")).toContain("ANTHROPIC_API_KEY");
  });

  test("a cancel exits 130 with nothing on stderr (Review Focus 5)", async () => {
    const h = deps({
      auth: {
        interaction: () => silent,
        runLogin: async () => Promise.reject(new AuthCancelledError("anthropic")),
      },
    });
    expect(await runLoginCommand({ provider: "anthropic" }, h.deps)).toBe(130);
    expect(h.err).toEqual([]);
    expect(h.out).toEqual([]);
  });

  test("a prompt cancel exits 130 with nothing on stderr", async () => {
    const h = deps({
      auth: {
        interaction: () => silent,
        runLogin: async () => Promise.reject(new PromptCancelledError()),
      },
    });
    expect(await runLoginCommand({ provider: "anthropic" }, h.deps)).toBe(130);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
  });

  test("a failure exits 1 with the message, secrets redacted", async () => {
    const h = deps({
      auth: {
        interaction: () => silent,
        runLogin: async () =>
          Promise.reject(
            new NaxError("Login failed: key sk-ant-api03-abcdefghijklmnopqrstuvwxyz rejected", "AUTH_LOGIN_FAILED"),
          ),
      },
    });
    expect(await runLoginCommand({ provider: "anthropic" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("nax-agent: Login failed");
    expect(h.err.join("\n")).not.toContain("abcdefghijklmnop");
  });
});
