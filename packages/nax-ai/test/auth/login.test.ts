import { afterEach, describe, expect, it, vi } from "vitest";
import { _resolveTarget, login } from "../../src/auth/login.ts";
import { AuthMethodUnavailableError, LoginCancelledError, LoginFailedError } from "../../src/auth/login-errors.ts";
import type { LoginInteraction, LoginPrompt } from "../../src/auth/login-types.ts";
import { OAuthFlowProhibitedError } from "../../src/auth/oauth-policy.ts";
import type { LoginRunner, LoginTarget } from "../../src/auth/pi-auth.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";

const real = _resolveTarget.resolve;
afterEach(() => {
  _resolveTarget.resolve = real;
});

function withTarget(target: LoginTarget): void {
  _resolveTarget.resolve = async () => target;
}

/** Fails the test if the flow tries to interact; individual tests override it. */
const silent: LoginInteraction = {
  prompt: async () => {
    throw new Error("no prompt expected");
  },
  notify: () => {},
};

describe("login", () => {
  it("runs the only available method and stores the credential", async () => {
    withTarget({
      apiKey: { label: "Acme API key", run: async () => ({ kind: "api-key", key: "sk-live" }) },
    });
    const credentials = createMemoryCredentialStore();

    const result = await login({ providerId: "acme", credentials, interaction: silent });

    expect(result).toEqual({ providerId: "acme", method: "api-key", kind: "api-key" });
    expect(await credentials.read("acme")).toEqual({ kind: "api-key", key: "sk-live" });
  });

  it("runs the only available method when it is oauth", async () => {
    withTarget({
      oauth: { label: "Acme OAuth", run: async () => ({ kind: "oauth", access: "a", refresh: "r", expires: 9 }) },
    });
    const credentials = createMemoryCredentialStore();

    const result = await login({ providerId: "acme", credentials, interaction: silent });

    expect(result.method).toBe("oauth");
    expect(result.kind).toBe("oauth");
    expect(await credentials.read("acme")).toEqual({ kind: "oauth", access: "a", refresh: "r", expires: 9 });
  });

  it("writes through modify, so the store's lock covers the write", async () => {
    // A bare write would bypass the cross-process lock that makes concurrent
    // logins and OAuth refreshes safe.
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk" }) } });
    const credentials = createMemoryCredentialStore();
    const modify = vi.spyOn(credentials, "modify");

    await login({ providerId: "acme", credentials, interaction: silent });

    expect(modify).toHaveBeenCalledWith("acme", expect.any(Function));
  });

  it("overwrites an existing credential for the provider", async () => {
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk-new" }) } });
    const credentials = createMemoryCredentialStore({ acme: { kind: "api-key", key: "sk-old" } });

    await login({ providerId: "acme", credentials, interaction: silent });

    expect(await credentials.read("acme")).toEqual({ kind: "api-key", key: "sk-new" });
  });

  it("does not return the credential", async () => {
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "sk-secret" }) } });

    const result = await login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent });

    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("rejects a provider with no usable method", async () => {
    withTarget({});
    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent }),
    ).rejects.toThrow(AuthMethodUnavailableError);
  });
});

describe("login method selection", () => {
  // Declared as standalone runners rather than plucked back off a LoginTarget:
  // reading an optional property out gives `LoginRunner | undefined`, which
  // will not assign to an optional property under exactOptionalPropertyTypes
  // (TS2375).
  const apiKeyRunner: LoginRunner = {
    label: "Acme API key",
    run: async () => ({ kind: "api-key", key: "sk" }),
  };
  const oauthRunner: LoginRunner = {
    label: "Sign in with Acme",
    run: async () => ({ kind: "oauth", access: "a", refresh: "r", expires: 1 }),
  };
  const both: LoginTarget = { apiKey: apiKeyRunner, oauth: oauthRunner };

  it("prompts for the method when both are available, labelled from the runners", async () => {
    withTarget(both);
    const prompts: LoginPrompt[] = [];
    const controller = new AbortController();
    const interaction: LoginInteraction = {
      prompt: async (prompt) => {
        prompts.push(prompt);
        return "oauth";
      },
      notify: () => {},
    };

    const result = await login({
      providerId: "acme",
      credentials: createMemoryCredentialStore(),
      interaction,
      signal: controller.signal,
    });

    expect(prompts[0]).toEqual({
      type: "select",
      message: expect.stringContaining("acme"),
      options: [
        { id: "api-key", label: "Acme API key" },
        { id: "oauth", label: "Sign in with Acme" },
      ],
      signal: controller.signal,
    });
    expect(result.method).toBe("oauth");
  });

  it("runs the method the user selected", async () => {
    withTarget(both);
    const interaction: LoginInteraction = { prompt: async () => "api-key", notify: () => {} };

    const result = await login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction });

    expect(result.method).toBe("api-key");
  });

  it("does not prompt when the caller named a method", async () => {
    withTarget(both);

    const result = await login({
      providerId: "acme",
      credentials: createMemoryCredentialStore(),
      interaction: silent, // throws if prompted
      method: "oauth",
    });

    expect(result.method).toBe("oauth");
  });

  it("rejects a named method the provider does not offer", async () => {
    withTarget({ apiKey: apiKeyRunner });

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent, method: "oauth" }),
    ).rejects.toThrow(AuthMethodUnavailableError);
  });

  it("reports which method was unavailable", async () => {
    withTarget({ apiKey: apiKeyRunner });

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent, method: "oauth" }),
    ).rejects.toMatchObject({ requested: "oauth" });
  });

  it("rejects an unrecognised selection rather than defaulting", async () => {
    // Silently falling back to the first method would bill a call against a
    // credential path the user did not choose.
    withTarget(both);
    const interaction: LoginInteraction = { prompt: async () => "neither", notify: () => {} };

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction }),
    ).rejects.toThrow(AuthMethodUnavailableError);
  });

  it("reports a rejected method prompt as cancellation", async () => {
    // The method prompt is part of the login: a consumer cancelling it must
    // surface the same LoginCancelledError as a cancelled flow prompt.
    withTarget(both);
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    const interaction: LoginInteraction = {
      prompt: async () => {
        throw abort;
      },
      notify: () => {},
    };

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction }),
    ).rejects.toThrow(LoginCancelledError);
  });

  it("reports an aborted signal during method selection as cancellation", async () => {
    // LoginOptions.signal reaches the method prompt: an already-aborted signal
    // cancels the select just as it would cancel a flow prompt. The prompt
    // would resolve for an idle signal, so the rejection can only come from
    // the abort.
    withTarget(both);
    const controller = new AbortController();
    controller.abort();
    const interaction: LoginInteraction = {
      prompt: async (prompt) => {
        if (prompt.signal?.aborted) throw new Error("method prompt aborted");
        return "api-key";
      },
      notify: () => {},
    };

    await expect(
      login({
        providerId: "acme",
        credentials: createMemoryCredentialStore(),
        interaction,
        signal: controller.signal,
      }),
    ).rejects.toThrow(LoginCancelledError);
  });
});

describe("login failure paths", () => {
  it("rejects an empty api-key rather than storing it", async () => {
    // fromPi maps a missing key to "". Storing that yields a credential that
    // looks present and fails at call time, far from its cause.
    withTarget({ apiKey: { label: "Acme", run: async () => ({ kind: "api-key", key: "" }) } });
    const credentials = createMemoryCredentialStore();

    await expect(login({ providerId: "acme", credentials, interaction: silent })).rejects.toThrow(LoginFailedError);
    expect(await credentials.read("acme")).toBeUndefined();
  });

  it("stores nothing when the flow throws", async () => {
    withTarget({
      apiKey: {
        label: "Acme",
        run: async () => {
          throw new Error("upstream said no");
        },
      },
    });
    const credentials = createMemoryCredentialStore();

    await expect(login({ providerId: "acme", credentials, interaction: silent })).rejects.toThrow("upstream said no");
    expect(await credentials.read("acme")).toBeUndefined();
  });

  it("reports a rejected prompt as cancellation, not failure", async () => {
    withTarget({
      apiKey: {
        label: "Acme",
        run: async (interaction) => {
          await interaction.prompt({ type: "secret", message: "API key" });
          return { kind: "api-key", key: "unreachable" };
        },
      },
    });
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    const interaction: LoginInteraction = {
      prompt: async () => {
        throw abort;
      },
      notify: () => {},
    };

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction }),
    ).rejects.toThrow(LoginCancelledError);
  });

  it("reports an aborted signal as cancellation", async () => {
    const controller = new AbortController();
    withTarget({
      apiKey: {
        label: "Acme",
        run: async () => {
          controller.abort();
          throw new Error("stream closed");
        },
      },
    });

    await expect(
      login({
        providerId: "acme",
        credentials: createMemoryCredentialStore(),
        interaction: silent,
        signal: controller.signal,
      }),
    ).rejects.toThrow(LoginCancelledError);
  });

  it("lets a policy refusal through as itself", async () => {
    // A prohibited flow must not be reported as a generic login failure: the
    // reason is the whole point of the error.
    withTarget({
      oauth: {
        label: "Acme OAuth",
        run: async () => {
          throw new OAuthFlowProhibitedError("acme", "not cleared");
        },
      },
    });

    await expect(
      login({ providerId: "acme", credentials: createMemoryCredentialStore(), interaction: silent }),
    ).rejects.toThrow(OAuthFlowProhibitedError);
  });
});
