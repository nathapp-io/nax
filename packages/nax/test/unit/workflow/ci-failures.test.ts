/**
 * The production CI-failure reader (US-008): a published PR's URL becomes a forge read of the
 * failed checks of its head. Every forge call goes through the injected `_ciFailuresDeps`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { assertNaxError, makeFeatureContext } from "@test/helpers";
import type { ForgeDeps, PrRef } from "@/forge";
import { _ciFailuresDeps, readCiFailuresFor } from "@/workflow/ci-failures";

const REF: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 9 };
const NO_NUMBER_URL = "https://github.com/o/r/issues/9";

const saved = { ..._ciFailuresDeps };
afterEach(() => {
  Object.assign(_ciFailuresDeps, saved);
});

/** A forge deps stub that fails the test if it is ever used. */
const unusedForge: ForgeDeps = {
  run: async () => {
    throw new Error("the forge must not be called");
  },
  readText: async () => null,
};

describe("readCiFailuresFor", () => {
  // AC-5: a URL with no pull-request number cannot name a PR, so the read fails with a NaxError.
  test("AC-5: a URL with no pull-request number rejects with WORKFLOW_CI_PR_URL", async () => {
    let caught: unknown;
    try {
      await readCiFailuresFor(makeFeatureContext(), { url: NO_NUMBER_URL, head: "abc" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught, "readCiFailuresFor rejection");
    expect(caught.code).toBe("WORKFLOW_CI_PR_URL");
  });

  // AC-6: no number, no PR ref to resolve.
  test("AC-6: a URL with no pull-request number resolves no PR ref", async () => {
    let resolveCalls = 0;
    _ciFailuresDeps.resolvePrRef = async () => {
      resolveCalls += 1;
      return REF;
    };
    _ciFailuresDeps.forge = unusedForge;
    await expect(readCiFailuresFor(makeFeatureContext(), { url: NO_NUMBER_URL, head: "abc" })).rejects.toThrow();
    expect(resolveCalls).toBe(0);
  });

  // AC-7: no number, no CI listing either.
  test("AC-7: a URL with no pull-request number reads no failed checks", async () => {
    let readCalls = 0;
    _ciFailuresDeps.readFailedChecks = async () => {
      readCalls += 1;
      return [];
    };
    _ciFailuresDeps.forge = unusedForge;
    await expect(readCiFailuresFor(makeFeatureContext(), { url: NO_NUMBER_URL, head: "abc" })).rejects.toThrow();
    expect(readCalls).toBe(0);
  });
});
