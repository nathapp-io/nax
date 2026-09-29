import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { _configRequirementsDeps, buildConfigRequirements } from "@/cli/config-requirements";

describe("buildConfigRequirements", () => {
  const originalNativeTierProviders = _configRequirementsDeps.nativeTierProviders;

  afterEach(() => {
    _configRequirementsDeps.nativeTierProviders = originalNativeTierProviders;
  });

  test("US-004 AC1 returns the resolved default agent", () => {
    const requirements = buildConfigRequirements(makeNaxConfig({ agent: { default: "claude" } }));
    expect(requirements.agent).toBe("claude");
  });

  test("US-004 AC2 selects ACP transport for a non-native default agent", () => {
    const requirements = buildConfigRequirements(makeNaxConfig({ agent: { default: "claude" } }));
    expect(requirements.transport).toBe("acp");
  });

  test("US-004 AC3 selects native transport for the native default agent", () => {
    const requirements = buildConfigRequirements(makeNaxConfig({ agent: { default: "native" } }));
    expect(requirements.transport).toBe("native");
  });

  test("US-004 AC4 defaults an omitted protocol to hybrid", () => {
    const config = makeNaxConfig({ agent: { protocol: undefined } });
    const requirements = buildConfigRequirements(config);
    expect(requirements.protocol).toBe("hybrid");
  });

  test("US-004 AC5 reports a configured native protocol", () => {
    const requirements = buildConfigRequirements(makeNaxConfig({ agent: { protocol: "native" } }));
    expect(requirements.protocol).toBe("native");
  });

  test("US-004 AC6 lists distinct native model providers in sorted order", () => {
    const requirements = buildConfigRequirements(
      makeNaxConfig({
        agent: { default: "native" },
        models: {
          native: { fast: "openai/gpt-a", balanced: "deepseek/ds-b", powerful: "openai/gpt-c" },
        },
      }),
    );
    expect(requirements.providers).toEqual(["deepseek", "openai"]);
  });

  test("US-004 AC7 omits providers when native is not the default agent", () => {
    const requirements = buildConfigRequirements(
      makeNaxConfig({
        agent: { default: "claude" },
        models: {
          native: { fast: "openai/gpt-a", balanced: "deepseek/ds-b", powerful: "openai/gpt-c" },
        },
      }),
    );
    expect(requirements.providers).toEqual([]);
  });

  test("US-004 AC8 requires sandbox for native when sandbox is at its default", () => {
    const requirements = buildConfigRequirements(makeNaxConfig({ agent: { default: "native" } }));
    expect(requirements.sandbox).toBe(true);
  });

  test("US-004 AC9 does not require sandbox when it is disabled", () => {
    const requirements = buildConfigRequirements(
      makeNaxConfig({ agent: { default: "native" }, execution: { sandbox: { enabled: false } } }),
    );
    expect(requirements.sandbox).toBe(false);
  });

  test("US-004 AC10 does not require sandbox for a non-native default agent", () => {
    const requirements = buildConfigRequirements(makeNaxConfig({ agent: { default: "claude" } }));
    expect(requirements.sandbox).toBe(false);
  });

  test("US-004 AC11 gets providers from the injected native-tier provider function", () => {
    _configRequirementsDeps.nativeTierProviders = () => new Map([["stub-provider", ["fast"]]]);
    const requirements = buildConfigRequirements(makeNaxConfig({ agent: { default: "native" } }));
    expect(requirements.providers).toEqual(["stub-provider"]);
  });

  test("US-004 AC12 passes the same config once to the injected provider function", () => {
    const config = makeNaxConfig({ agent: { default: "native" } });
    const spy = mock((value: Parameters<typeof originalNativeTierProviders>[0]) => {
      expect(value).toBe(config);
      return new Map<string, string[]>();
    });
    _configRequirementsDeps.nativeTierProviders = spy;
    buildConfigRequirements(config);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
