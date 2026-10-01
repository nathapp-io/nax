import type { AuthEvent, AuthPrompt, Provider as PiProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthMethodUnavailableError } from "../../src/auth/login-errors.ts";
import type { LoginEvent, LoginPrompt } from "../../src/auth/login-types.ts";
import { OAuthFlowProhibitedError } from "../../src/auth/oauth-policy.ts";
import { _loginDeps, resolveLoginTarget } from "../../src/auth/pi-auth.ts";

/**
 * A pi provider is a large structural type and this suite reads four fields of
 * it, so the doubles are built narrow and cast. Widening them would test the
 * cast, not the dispatch.
 */
function piProvider(input: {
  id: string;
  apiKey?: { name: string; withLogin: boolean };
  oauth?: { name: string; loginLabel?: string };
}): PiProvider {
  return {
    id: input.id,
    name: input.id,
    auth: {
      ...(input.apiKey !== undefined
        ? {
            apiKey: {
              name: input.apiKey.name,
              ...(input.apiKey.withLogin ? { login: async () => ({ type: "api_key", key: "k" }) } : {}),
            },
          }
        : {}),
      ...(input.oauth !== undefined
        ? {
            oauth: {
              name: input.oauth.name,
              ...(input.oauth.loginLabel !== undefined ? { loginLabel: input.oauth.loginLabel } : {}),
              login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }),
            },
          }
        : {}),
    },
  } as unknown as PiProvider;
}

const real = _loginDeps.providers;
afterEach(() => {
  _loginDeps.providers = real;
});

function withProviders(providers: readonly PiProvider[]): void {
  _loginDeps.providers = async () => providers;
}

describe("resolveLoginTarget", () => {
  it("offers oauth for a provider the catalog projection reports as api-key", async () => {
    // openrouter declares both, so toProviderAuth maps it to "api-key". This is
    // the trap: dispatching on the projection would never run its OAuth flow.
    withProviders([
      piProvider({
        id: "openrouter",
        apiKey: { name: "OpenRouter API key", withLogin: true },
        oauth: { name: "OpenRouter OAuth" },
      }),
    ]);

    const target = await resolveLoginTarget("openrouter");

    expect(target.oauth).toBeDefined();
    expect(target.apiKey).toBeDefined();
  });

  it("does not offer oauth for a provider outside the allowlist", async () => {
    withProviders([
      piProvider({
        id: "anthropic",
        apiKey: { name: "Anthropic API key", withLogin: true },
        oauth: { name: "Anthropic (Claude Pro/Max)" },
      }),
    ]);

    const target = await resolveLoginTarget("anthropic");

    expect(target.oauth).toBeUndefined();
    expect(target.apiKey).toBeDefined();
  });

  it("does not offer oauth for github-copilot, whose entry is not cleared", async () => {
    withProviders([
      piProvider({
        id: "github-copilot",
        apiKey: { name: "GitHub token", withLogin: true },
        oauth: { name: "GitHub Copilot" },
      }),
    ]);

    expect((await resolveLoginTarget("github-copilot")).oauth).toBeUndefined();
  });

  it("offers oauth only, for a provider with no api-key auth", async () => {
    withProviders([piProvider({ id: "openai-codex", oauth: { name: "OpenAI (ChatGPT Plus/Pro)" } })]);

    const target = await resolveLoginTarget("openai-codex");

    expect(target.oauth).toBeDefined();
    expect(target.apiKey).toBeUndefined();
  });

  it("does not offer an api-key method the provider cannot run interactively", async () => {
    // Ambient-only providers omit `login`; offering one would prompt for a key
    // the provider has no way to accept.
    withProviders([piProvider({ id: "bedrock", apiKey: { name: "AWS profile", withLogin: false } })]);

    expect((await resolveLoginTarget("bedrock")).apiKey).toBeUndefined();
  });

  it("prefers the oauth loginLabel over its name when both exist", async () => {
    withProviders([
      piProvider({ id: "openrouter", oauth: { name: "OpenRouter OAuth", loginLabel: "Sign in with OpenRouter" } }),
    ]);

    expect((await resolveLoginTarget("openrouter")).oauth?.label).toBe("Sign in with OpenRouter");
  });

  it("rejects an unknown provider", async () => {
    withProviders([]);
    await expect(resolveLoginTarget("nope")).rejects.toThrow(AuthMethodUnavailableError);
  });

  it("raises the policy error when a provider's only method is a prohibited oauth flow", async () => {
    // A policy refusal must not read as an absence: with no api-key login and
    // only a prohibited OAuth flow the target is empty — but the reason is a
    // refusal, and it must keep its own error type.
    withProviders([piProvider({ id: "anthropic", oauth: { name: "Anthropic (Claude Pro/Max)" } })]);

    await expect(resolveLoginTarget("anthropic")).rejects.toThrow(OAuthFlowProhibitedError);
  });
});

describe("interaction translation", () => {
  function recorder() {
    const prompts: LoginPrompt[] = [];
    const events: LoginEvent[] = [];
    return {
      prompts,
      events,
      interaction: {
        prompt: async (prompt: LoginPrompt) => {
          prompts.push(prompt);
          return "answer";
        },
        notify: (event: LoginEvent) => {
          events.push(event);
        },
      },
    };
  }

  /** Drives the translation the way pi does: through a resolved runner. */
  async function drive(input: { prompt?: AuthPrompt; event?: AuthEvent }) {
    const seen = recorder();
    withProviders([
      {
        id: "acme",
        name: "acme",
        auth: {
          apiKey: {
            name: "Acme API key",
            login: async (interaction: { prompt(p: AuthPrompt): Promise<string>; notify(e: AuthEvent): void }) => {
              if (input.event !== undefined) interaction.notify(input.event);
              if (input.prompt !== undefined) await interaction.prompt(input.prompt);
              return { type: "api_key", key: "k" };
            },
          },
        },
      } as unknown as PiProvider,
    ]);
    const target = await resolveLoginTarget("acme");
    await target.apiKey?.run(seen.interaction, new AbortController().signal);
    return seen;
  }

  it("renames manual_code to manual-code", async () => {
    const seen = await drive({ prompt: { type: "manual_code", message: "Paste the URL" } });
    expect(seen.prompts[0]).toEqual({ type: "manual-code", message: "Paste the URL" });
  });

  it("passes a secret prompt through unchanged", async () => {
    const seen = await drive({ prompt: { type: "secret", message: "API key", placeholder: "sk-..." } });
    expect(seen.prompts[0]).toEqual({ type: "secret", message: "API key", placeholder: "sk-..." });
  });

  it("carries select options through", async () => {
    const seen = await drive({
      prompt: { type: "select", message: "Pick", options: [{ id: "a", label: "A", description: "first" }] },
    });
    expect(seen.prompts[0]).toEqual({
      type: "select",
      message: "Pick",
      options: [{ id: "a", label: "A", description: "first" }],
    });
  });

  it("renames auth_url to auth-url", async () => {
    const seen = await drive({ event: { type: "auth_url", url: "https://x", instructions: "open it" } });
    expect(seen.events[0]).toEqual({ type: "auth-url", url: "https://x", instructions: "open it" });
  });

  it("renames device_code to device-code and keeps its timings", async () => {
    const seen = await drive({
      event: { type: "device_code", userCode: "ABCD", verificationUri: "https://v", intervalSeconds: 5 },
    });
    expect(seen.events[0]).toEqual({
      type: "device-code",
      userCode: "ABCD",
      verificationUri: "https://v",
      intervalSeconds: 5,
    });
  });

  it("omits an absent optional rather than setting it undefined", async () => {
    // exactOptionalPropertyTypes: an absent field and a field set to undefined
    // are different things, and a consumer rendering `"instructions" in event`
    // would see the wrong answer.
    const seen = await drive({ event: { type: "auth_url", url: "https://x" } });
    expect(seen.events[0]).not.toHaveProperty("instructions");
  });

  it("returns the consumer's answer to pi", async () => {
    const seen = await drive({ prompt: { type: "text", message: "Name" } });
    expect(seen.prompts).toHaveLength(1);
  });
});
