import { afterEach, describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { isRemotePlainHttp, NaxConfigSchema } from "@/config";
import type { ProviderCatalogOverride } from "@/config/schema-types";
import { checkCatalogEndpoints } from "@/precheck/checks-catalog-endpoints";
import { _modelResolutionDeps, checkModelResolution } from "@/precheck/checks-model-resolution";

const override: ProviderCatalogOverride = {
  provider: "strata",
  models: [
    {
      id: "qwen",
      protocol: "openai-completions",
      contextWindow: 32768,
      supportsTools: true,
      thinkingLevels: ["off"],
      pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
};
const remote = "http://192.168.1.175:8080/v1";

describe("checkCatalogEndpoints", () => {
  test("AC-10 warns about explicitly allowed unencrypted credentials", () => {
    const rows = checkCatalogEndpoints([{ ...override, baseUrl: remote, allowInsecureHttp: true }], {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: "warning", passed: false });
    for (const text of ["strata", "192.168.1.175", "allowInsecureHttp", "unencrypted"])
      expect(rows[0]?.message).toContain(text);
  });
  test.each(["https://gw.test/v1", "http://127.0.0.1:18080/v1"])("AC-11/12 no insecure warning for %s", (baseUrl) => {
    expect(checkCatalogEndpoints([{ ...override, baseUrl, allowInsecureHttp: true }], {})).toEqual([]);
  });
  test.each([{}, { STRATA_API_KEY: "" }])("AC-13 warns for absent or empty authEnv %j", (env) => {
    const rows = checkCatalogEndpoints([{ ...override, authEnv: "STRATA_API_KEY" }], env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: "warning", passed: false });
    expect(rows[0]?.message).toContain("strata");
    expect(rows[0]?.message).toContain("STRATA_API_KEY");
  });
  test("AC-14 set authEnv needs no unset warning", () => {
    expect(checkCatalogEndpoints([{ ...override, authEnv: "STRATA_API_KEY" }], { STRATA_API_KEY: "x" })).toEqual([]);
  });
  test("AC-15 warns about bearer credential destination without exposing value", () => {
    const rows = checkCatalogEndpoints([{ ...override, authEnv: "STRATA_API_KEY", baseUrl: "https://gw.test/v1" }], {
      STRATA_API_KEY: "secret-value",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: "warning", passed: false });
    for (const text of ["strata", "STRATA_API_KEY", "gw.test", "bearer credential"])
      expect(rows[0]?.message).toContain(text);
    expect(JSON.stringify(rows)).not.toContain("secret-value");
  });
  test("separate reasons produce separate warnings", () => {
    expect(
      checkCatalogEndpoints([{ ...override, authEnv: "STRATA_API_KEY", baseUrl: remote, allowInsecureHttp: true }], {}),
    ).toHaveLength(3);
    expect(checkCatalogEndpoints([], {})).toEqual([]);
  });
});

describe("isRemotePlainHttp", () => {
  test.each([
    [remote, true],
    ["http://[::1]:8080/v1", false],
    ["https://gw.test/v1", false],
    ["not a url", false],
    ["file:///etc/passwd", false],
    ["http://localhost/v1", false],
    ["http://127.0.0.1/v1", false],
  ])("AC-16/17/18 classifies %s", (url, expected) => expect(isRemotePlainHttp(url)).toBe(expected));
});

describe("checkModelResolution endpoint integration", () => {
  const original = { ..._modelResolutionDeps };
  afterEach(() => Object.assign(_modelResolutionDeps, original));
  test("AC-19 uses injected env before the empty-check success fallback", async () => {
    _modelResolutionDeps.env = {};
    _modelResolutionDeps.resolveNative = async () => ({ status: "resolved" });
    const config = NaxConfigSchema.parse({
      agent: { native: { catalogOverrides: [{ ...override, authEnv: "STRATA_API_KEY" }] } },
    });
    const rows = await checkModelResolution(config);
    expect(rows.some((row) => row.tier === "warning" && !row.passed && row.message.includes("STRATA_API_KEY"))).toBe(
      true,
    );
  });
});

describe("custom provider field descriptions", () => {
  test.each(["authEnv", "allowInsecureHttp"])("AC-20 describes %s", (field) => {
    expect(FIELD_DESCRIPTIONS[`agent.native.catalogOverrides.${field}`]?.length).toBeGreaterThan(0);
  });
  test("AC-21 describes openrouter", () =>
    expect(FIELD_DESCRIPTIONS["agent.native.catalogOverrides.thinkingFormat"]).toContain("openrouter"));
});
