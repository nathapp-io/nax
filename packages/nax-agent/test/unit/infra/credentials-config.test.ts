import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetCredentialsConfig,
  type CredentialsConfig,
  configureCredentials,
  credentialsConfig,
} from "#src/infra/credentials-config";
import type { NaxError } from "#src/infra/index";
import { assertNaxError } from "#test/helpers/index";

/**
 * The slot is process-global and the preload (or another suite) may have
 * configured it: save what was there and put it back, so this file leaves the
 * module exactly as it found it.
 */
let saved: CredentialsConfig | undefined;
let wasConfigured = false;

beforeEach(() => {
  try {
    saved = credentialsConfig();
    wasConfigured = true;
  } catch {
    wasConfigured = false;
  }
});

afterEach(() => {
  if (wasConfigured && saved !== undefined) configureCredentials(saved);
  else _resetCredentialsConfig();
});

/** Run a function that must throw a NaxError, and return it asserted. */
function expectNaxError(run: () => unknown, label: string): NaxError {
  try {
    run();
  } catch (err) {
    assertNaxError(err, label);
    return err;
  }
  throw new Error(`${label}: expected a NaxError`);
}

describe("credentialsConfig", () => {
  test("throws CREDENTIALS_NOT_CONFIGURED at stage credentials when the slot is unset", () => {
    _resetCredentialsConfig();
    const err = expectNaxError(() => credentialsConfig(), "unset slot");
    expect(err.code).toBe("CREDENTIALS_NOT_CONFIGURED");
  });

  test("returns the configured config, and only that instance", () => {
    const config: CredentialsConfig = {
      configDir: () => "/tmp/does-not-matter",
      readAuthConfig: async () => ({ source: "file", onChange: "warn" }),
    };
    configureCredentials(config);
    expect(credentialsConfig()).toBe(config);
  });

  test("_resetCredentialsConfig clears the slot again", () => {
    configureCredentials({ configDir: () => "/", readAuthConfig: async () => ({ source: "file", onChange: "warn" }) });
    _resetCredentialsConfig();
    expect(() => credentialsConfig()).toThrow();
  });
});
