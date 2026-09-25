/**
 * checkNativeCredentials: with native the built-in default agent, an install
 * whose only credential belongs to another provider must fail before a billed
 * call, not at the first request to the default tier map's provider.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _nativeCredentialDeps, checkNativeCredentials } from "@/precheck/checks";

const originalDeps = { ..._nativeCredentialDeps };

afterEach(() => {
  _nativeCredentialDeps.providersWithoutCredentials = originalDeps.providersWithoutCredentials;
});

describe("checkNativeCredentials", () => {
  test("blocks when a provider the default native map names has no credential, naming it and the fixes", async () => {
    const asked: string[][] = [];
    _nativeCredentialDeps.providersWithoutCredentials = mock(async (ids: readonly string[]) => {
      asked.push([...ids]);
      return ["anthropic"];
    });

    const check = await checkNativeCredentials(makeNaxConfig());

    expect(asked).toEqual([["anthropic"]]);
    expect(check.passed).toBe(false);
    expect(check.tier).toBe("blocker");
    expect(check.name).toBe("native-credentials");
    expect(check.message).toContain("anthropic");
    expect(check.message).toContain("nax auth login anthropic");
    expect(check.message).toContain('agent.default "claude"');
  });

  test("passes when every provider has a credential", async () => {
    _nativeCredentialDeps.providersWithoutCredentials = mock(async () => []);
    const check = await checkNativeCredentials(makeNaxConfig());
    expect(check.passed).toBe(true);
  });

  test("asks about each provider in the configured map once, from string and object entries", async () => {
    const asked: string[][] = [];
    _nativeCredentialDeps.providersWithoutCredentials = mock(async (ids: readonly string[]) => {
      asked.push([...ids]);
      return [];
    });
    await checkNativeCredentials(
      makeNaxConfig({
        models: {
          native: {
            fast: "openrouter/deepseek/deepseek-v4[high]",
            balanced: { provider: "minimax", model: "minimax/MiniMax-M3" },
            powerful: "openrouter/z-ai/glm-5.3",
          },
        },
      }),
    );
    expect(asked).toEqual([["openrouter", "minimax"]]);
  });

  test("names the tiers that use a missing provider", async () => {
    _nativeCredentialDeps.providersWithoutCredentials = mock(async () => ["anthropic"]);
    const check = await checkNativeCredentials(
      makeNaxConfig({ models: { native: { fast: "openrouter/deepseek/deepseek-v4" } } }),
    );
    // fast is overridden to openrouter; balanced/powerful keep the built-in anthropic ids.
    expect(check.message).toContain("models.native.balanced");
    expect(check.message).toContain("models.native.powerful");
    expect(check.message).not.toContain("models.native.fast");
  });

  test("skips providers declared in agent.native.catalogOverrides: they authenticate through the override", async () => {
    const asked: string[][] = [];
    _nativeCredentialDeps.providersWithoutCredentials = mock(async (ids: readonly string[]) => {
      asked.push([...ids]);
      return [];
    });
    await checkNativeCredentials(
      makeNaxConfig({
        models: {
          native: { fast: "lmstudio/qwen3", balanced: "lmstudio/qwen3", powerful: "anthropic/claude-opus-5-5" },
        },
        agent: {
          native: {
            catalogOverrides: [
              { provider: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "qwen3" }] },
            ],
          },
        },
      }),
    );
    expect(asked).toEqual([["anthropic"]]);
  });

  test("skips an entry with no provider prefix instead of guessing one", async () => {
    const asked: string[][] = [];
    _nativeCredentialDeps.providersWithoutCredentials = mock(async (ids: readonly string[]) => {
      asked.push([...ids]);
      return [];
    });
    await checkNativeCredentials(
      makeNaxConfig({
        models: { native: { fast: "deepseek-v4", balanced: "openai/gpt-5.4", powerful: "openai/gpt-5.4" } },
      }),
    );
    expect(asked).toEqual([["openai"]]);
  });

  test("does not apply when the default agent is an acpx agent", async () => {
    const probe = mock(async () => ["anthropic"]);
    _nativeCredentialDeps.providersWithoutCredentials = probe;
    const check = await checkNativeCredentials(makeNaxConfig({ agent: { default: "claude" } }));
    expect(check.passed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
