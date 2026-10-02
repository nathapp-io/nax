import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetCredentialsConfig,
  configureCredentials,
  credentialsConfig,
  NaxError,
} from "@nathapp/nax-agent/internal";
import { configureNaxCredentials } from "@/config";

describe("credentials slot", () => {
  afterEach(() => configureNaxCredentials());

  test("unset slot throws CREDENTIALS_NOT_CONFIGURED", () => {
    _resetCredentialsConfig();
    let caught: unknown;
    try {
      credentialsConfig();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
    expect(caught).toMatchObject({ code: "CREDENTIALS_NOT_CONFIGURED" });
  });

  test("serves the configured functions", async () => {
    configureCredentials({
      configDir: () => "/cfg",
      readAuthConfig: async () => ({ source: "file", onChange: "refuse" }),
    });
    expect(credentialsConfig().configDir()).toBe("/cfg");
    expect((await credentialsConfig().readAuthConfig()).onChange).toBe("refuse");
  });
});
