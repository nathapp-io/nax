import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _authDeps, AuthCancelledError, runLogin } from "@/agents/native/auth";
import type { AuthInteraction } from "@/agents/native/auth-types";
import { _resetCredentialStore } from "@/agents/native/credentials";

const realLogin = _authDeps.login;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

const silent: AuthInteraction = { prompt: async () => "", notify: () => undefined };

let dir: string;

beforeEach(() => {
  dir = makeTempDir("nax-login-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
});

afterEach(() => {
  _authDeps.login = realLogin;
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
});

describe("runLogin", () => {
  test("passes the store and a mapped interaction, and returns the result verbatim", async () => {
    let seen: { providerId: string; hasStore: boolean } | undefined;
    _authDeps.login = mock(async (options: { providerId: string; credentials: unknown }) => {
      seen = { providerId: options.providerId, hasStore: options.credentials !== undefined };
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });

    const result = await runLogin("openrouter", silent);

    expect(seen).toEqual({ providerId: "openrouter", hasStore: true });
    // kind is reported as returned, never derived from method: M5 predicted
    // api-key here and its live run returned oauth.
    expect(result).toEqual({ providerId: "openrouter", method: "oauth", kind: "oauth" });
  });

  test("does not pass a method, so nax-ai runs its own selection prompt", async () => {
    let sawMethodKey = true;
    _authDeps.login = mock(async (options: object) => {
      sawMethodKey = "method" in options;
      return { providerId: "p", method: "api-key" as const, kind: "api-key" as const };
    });
    await runLogin("p", silent);
    expect(sawMethodKey).toBe(false);
  });

  test("turns a cancellation into AuthCancelledError", async () => {
    class LoginCancelledError extends Error {
      constructor() {
        super("cancelled");
        this.name = "LoginCancelledError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new LoginCancelledError();
    });
    await expect(runLogin("openrouter", silent)).rejects.toBeInstanceOf(AuthCancelledError);
  });

  test("keeps a prohibited flow's recorded reason in the message", async () => {
    class OAuthFlowProhibitedError extends Error {
      constructor() {
        super('OAuth flow for "github-copilot" is prohibited: not cleared, isSubscription: true');
        this.name = "OAuthFlowProhibitedError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new OAuthFlowProhibitedError();
    });
    await expect(runLogin("github-copilot", silent)).rejects.toThrow(/not cleared/);
  });

  test("reports an unavailable method with code AUTH_METHOD_UNAVAILABLE", async () => {
    class AuthMethodUnavailableError extends Error {
      constructor() {
        super("no method");
        this.name = "AuthMethodUnavailableError";
      }
    }
    _authDeps.login = mock(async () => {
      throw new AuthMethodUnavailableError();
    });
    await expect(runLogin("nope", silent)).rejects.toMatchObject({ code: "AUTH_METHOD_UNAVAILABLE" });
    await expect(runLogin("nope", silent)).rejects.toThrow(/No login method is available/);
  });

  test("names the requested method rather than claiming none is available", async () => {
    class AuthMethodUnavailableError extends Error {
      requested: string;
      constructor(requested: string) {
        super("no method");
        this.name = "AuthMethodUnavailableError";
        this.requested = requested;
      }
    }
    _authDeps.login = mock(async () => {
      throw new AuthMethodUnavailableError("api-key");
    });

    // The provider does offer oauth: saying "no login method is available"
    // would send the user chasing a config problem that does not exist.
    await expect(runLogin("openai-codex", silent, "api-key")).rejects.toThrow(/does not offer "api-key" login/);
    await expect(runLogin("openai-codex", silent, "api-key")).rejects.not.toThrow(/No login method is available/);
  });

  test("forwards the requested method to nax-ai", async () => {
    let seen: unknown;
    _authDeps.login = mock(async (options: { method?: string }) => {
      seen = options.method;
      return { providerId: "openrouter", method: "oauth" as const, kind: "oauth" as const };
    });
    await runLogin("openrouter", silent, "oauth");
    expect(seen).toBe("oauth");
  });

  test("reports any other failure with code AUTH_LOGIN_FAILED", async () => {
    _authDeps.login = mock(async () => {
      throw new Error("the provider said no");
    });
    await expect(runLogin("openrouter", silent)).rejects.toMatchObject({ code: "AUTH_LOGIN_FAILED" });
  });
});
