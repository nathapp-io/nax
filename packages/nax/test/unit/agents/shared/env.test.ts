/**
 * Tests for the shared env builders (src/agents/shared/env.ts):
 * buildAllowedEnv() — issue #52's single canonical allowlist that replaced the
 * duplicate logic in execution.ts and spawn-client.ts — and, for ACP run
 * sessions, acpProviderEnvFamily() and buildAcpRunEnv() (US-001, M7).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acpProviderEnvFamily, buildAcpChatEnv, buildAcpRunEnv, buildAllowedEnv } from "@/agents/shared/env";

/** The provider key vars a multi-provider agent keeps (API_KEY_VARS in env.ts). */
const MULTI_PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "CLAUDE_API_KEY",
];
const MULTI_PROVIDER_PREFIXES = ["CLAUDE_", "ANTHROPIC_", "CODEX_", "GEMINI_", "OPENCODE_", "MINIMAX_", "CURSOR_"];

/** Env vars a test sets, restored after every test (the file's tests run in one process). */
const touchedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string | undefined): void {
  if (!touchedEnv.has(key)) touchedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of touchedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touchedEnv.clear();
});

describe("buildAllowedEnv (shared)", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
  });

  test("includes PATH and HOME", () => {
    const env = buildAllowedEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBeDefined();
  });

  test("includes ANTHROPIC_API_KEY when set", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const env = buildAllowedEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("test-key");
  });

  test("includes GEMINI_API_KEY when set", () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    const env = buildAllowedEnv();
    expect(env.GEMINI_API_KEY).toBe("gemini-key");
  });

  test("includes OPENAI_API_KEY when set", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    const env = buildAllowedEnv();
    expect(env.OPENAI_API_KEY).toBe("openai-key");
  });

  test("includes NAX_* prefix vars", () => {
    process.env.NAX_SKIP_PRECHECK = "1";
    const env = buildAllowedEnv();
    expect(env.NAX_SKIP_PRECHECK).toBe("1");
  });

  test("S4b-5: ACPX_* prefix vars are no longer passed through", () => {
    process.env.ACPX_TIMEOUT = "30000";
    const env = buildAllowedEnv();
    expect(env).not.toHaveProperty("ACPX_TIMEOUT");
  });

  test("includes ANTHROPIC_* prefix vars (beyond API key)", () => {
    process.env.ANTHROPIC_BASE_URL = "https://example.com";
    const env = buildAllowedEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.com");
  });

  test("does NOT include arbitrary env vars", () => {
    process.env.MY_SECRET_TOKEN = "should-not-pass";
    const env = buildAllowedEnv();
    expect(env.MY_SECRET_TOKEN).toBeUndefined();
  });

  test("extra env overrides process.env vars", () => {
    process.env.NAX_FOO = "original";
    const env = buildAllowedEnv({ env: { NAX_FOO: "override" } });
    expect(env.NAX_FOO).toBe("override");
  });

  test("modelEnv is merged before extra env", () => {
    const env = buildAllowedEnv({
      modelEnv: { CLAUDE_MODEL: "model-from-def" },
      env: { CLAUDE_MODEL: "model-from-call" },
    });
    // call-site env wins over modelEnv
    expect(env.CLAUDE_MODEL).toBe("model-from-call");
  });

  test("modelEnv vars are included when no override", () => {
    const env = buildAllowedEnv({ modelEnv: { CLAUDE_EXTRA: "from-model" } });
    expect(env.CLAUDE_EXTRA).toBe("from-model");
  });

  test("works with no arguments", () => {
    expect(() => buildAllowedEnv()).not.toThrow();
    const env = buildAllowedEnv();
    expect(typeof env).toBe("object");
  });
});

describe("acpProviderEnvFamily (US-001)", () => {
  test("AC-1: codex sees only OPENAI_API_KEY and the CODEX_ prefix", () => {
    expect(acpProviderEnvFamily("codex")).toEqual({ keys: ["OPENAI_API_KEY"], prefixes: ["CODEX_"] });
  });

  test("AC-2: pi is multi-provider: every provider key and every provider prefix", () => {
    expect(acpProviderEnvFamily("pi")).toEqual({
      keys: MULTI_PROVIDER_KEYS,
      prefixes: MULTI_PROVIDER_PREFIXES,
    });
  });

  test("AC-3: a custom agent name is multi-provider, exactly like pi", () => {
    expect(acpProviderEnvFamily("my-custom-agent")).toEqual(acpProviderEnvFamily("pi"));
  });

  test.each([
    ["claude", ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], ["CLAUDE_", "ANTHROPIC_"]],
    ["gemini", ["GEMINI_API_KEY", "GOOGLE_API_KEY"], ["GEMINI_"]],
    ["cursor", [], ["CURSOR_"]],
  ])("%s's family matches the spec's table", (agent, keys, prefixes) => {
    expect(acpProviderEnvFamily(agent)).toEqual({ keys, prefixes });
  });

  test("opencode is multi-provider as well", () => {
    expect(acpProviderEnvFamily("opencode")).toEqual(acpProviderEnvFamily("pi"));
  });
});

describe("buildAcpRunEnv (US-001)", () => {
  test("AC-4: a codex run gets its own provider vars, no other provider's key and no NAX_/CLAW_/TURBO_ secret", () => {
    setEnv("NAX_TELEGRAM_TOKEN", "nax-secret");
    setEnv("CLAW_TOKEN", "claw-secret");
    setEnv("TURBO_TOKEN", "turbo-secret");
    setEnv("ANTHROPIC_API_KEY", "anthropic-key");
    setEnv("OPENAI_API_KEY", "openai-key");
    setEnv("CODEX_HOME", "/home/user/.codex");
    const env = buildAcpRunEnv("codex");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env.CODEX_HOME).toBe("/home/user/.codex");
    expect(env).not.toHaveProperty("NAX_TELEGRAM_TOKEN");
    expect(env).not.toHaveProperty("CLAW_TOKEN");
    expect(env).not.toHaveProperty("TURBO_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  test("AC-5: a multi-provider agent keeps every provider key but still loses the NAX_ secret", () => {
    setEnv("ANTHROPIC_API_KEY", "anthropic-key");
    setEnv("OPENAI_API_KEY", "openai-key");
    setEnv("NAX_TELEGRAM_TOKEN", "nax-secret");
    const env = buildAcpRunEnv("opencode");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env).not.toHaveProperty("NAX_TELEGRAM_TOKEN");
  });

  test("AC-6: the model's own env wins over the family filter", () => {
    expect(buildAcpRunEnv("claude", { NAX_FOO: "1" }).NAX_FOO).toBe("1");
  });

  test("AC-7: an absolute HOME is passed through", () => {
    setEnv("HOME", "/abs/home");
    expect(buildAcpRunEnv("claude").HOME).toBe("/abs/home");
  });

  test("AC-8: a missing HOME falls back to an absolute home directory", () => {
    setEnv("HOME", undefined);
    const home = buildAcpRunEnv("claude").HOME;
    expect(home).toBeDefined();
    expect(home?.startsWith("/")).toBe(true);
  });

  test("AC-9: essential OS vars stay; an unrelated variable does not", () => {
    setEnv("PATH", "/usr/bin:/bin");
    setEnv("UNRELATED_VAR", "nope");
    const env = buildAcpRunEnv("claude");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env).not.toHaveProperty("UNRELATED_VAR");
  });
});

describe("buildAcpChatEnv (US-002)", () => {
  test("AC-1: a chat brain sees none of nax's own secrets, including the Telegram fallback name", () => {
    setEnv("NAX_TELEGRAM_TOKEN", "nax-secret");
    setEnv("TELEGRAM_BOT_TOKEN", "bot-secret");
    setEnv("CLAW_TOKEN", "claw-secret");
    setEnv("TURBO_TOKEN", "turbo-secret");
    const env = buildAcpChatEnv("claude");
    expect(env).not.toHaveProperty("NAX_TELEGRAM_TOKEN");
    expect(env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(env).not.toHaveProperty("CLAW_TOKEN");
    expect(env).not.toHaveProperty("TURBO_TOKEN");
  });

  test("AC-2: the interactive toolchain stays — ssh agent, gh token, proxy and editor", () => {
    setEnv("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
    setEnv("GH_TOKEN", "gh-token");
    setEnv("HTTPS_PROXY", "http://proxy.example:3128");
    setEnv("EDITOR", "vim");
    const env = buildAcpChatEnv("codex");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(env.GH_TOKEN).toBe("gh-token");
    expect(env.HTTPS_PROXY).toBe("http://proxy.example:3128");
    expect(env.EDITOR).toBe("vim");
  });

  test("AC-3: a codex chat brain keeps its own provider's key and prefix, not claude's", () => {
    setEnv("OPENAI_API_KEY", "openai-key");
    setEnv("CODEX_HOME", "/home/user/.codex");
    setEnv("ANTHROPIC_API_KEY", "anthropic-key");
    setEnv("CLAUDE_CONFIG_DIR", "/home/user/.claude");
    const env = buildAcpChatEnv("codex");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env.CODEX_HOME).toBe("/home/user/.codex");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  test("AC-4: a claude chat brain keeps its own provider's key and prefix, not codex's", () => {
    setEnv("ANTHROPIC_API_KEY", "anthropic-key");
    setEnv("CLAUDE_CONFIG_DIR", "/home/user/.claude");
    setEnv("OPENAI_API_KEY", "openai-key");
    const env = buildAcpChatEnv("claude");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/user/.claude");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("AC-5: a cursor chat brain keeps CURSOR_API_KEY and not another provider's key", () => {
    setEnv("CURSOR_API_KEY", "cursor-key");
    setEnv("GEMINI_API_KEY", "gemini-key");
    const env = buildAcpChatEnv("cursor");
    expect(env.CURSOR_API_KEY).toBe("cursor-key");
    expect(env).not.toHaveProperty("GEMINI_API_KEY");
  });

  test("AC-6: a name the backend rejects and a value carrying NUL are both dropped", () => {
    setEnv("BAD-NAME", "x");
    setEnv("GOOD", "before\u0000after");
    const env = buildAcpChatEnv("claude");
    expect(env).not.toHaveProperty("BAD-NAME");
    expect(env).not.toHaveProperty("GOOD");
  });

  test("a multi-provider agent keeps every provider key, as it does today", () => {
    setEnv("ANTHROPIC_API_KEY", "anthropic-key");
    setEnv("OPENAI_API_KEY", "openai-key");
    setEnv("NAX_TELEGRAM_TOKEN", "nax-secret");
    const env = buildAcpChatEnv("opencode");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env).not.toHaveProperty("NAX_TELEGRAM_TOKEN");
  });

  test("HOME is not sanitised: chat keeps the user's own value", () => {
    setEnv("HOME", "/abs/home");
    expect(buildAcpChatEnv("claude").HOME).toBe("/abs/home");
  });
});
