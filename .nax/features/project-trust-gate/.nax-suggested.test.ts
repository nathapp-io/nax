import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { rejectGlobalOnlyKeys } from "@/config/global-only-keys";
import { NaxError } from "@/errors";

/**
 * Await the call and return the NaxError it failed with. A synchronous throw
 * and a rejected promise are handled identically, which is what the project
 * convention means by "throws CODE": the outcome rejects with a NaxError
 * whose code is CODE. Fails the test when the call resolves instead.
 */
async function catchNaxError(run: () => unknown): Promise<NaxError> {
  try {
    await run();
  } catch (err) {
    assertNaxError(err, "rejectGlobalOnlyKeys rejection");
    return err;
  }
  throw new Error("expected a NaxError, but the call resolved");
}

describe("rejectGlobalOnlyKeys", () => {
  test("AC-1: a layer with an auth key still rejects with AUTH_CONFIG_NOT_GLOBAL after the trust-key extension", async () => {
    const err = await catchNaxError(() => rejectGlobalOnlyKeys({ auth: {} }, "project config"));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
    // The auth key must not trip the new trust-only rejection — that code is
    // reserved for the `trust` key alone.
    expect(err.code).not.toBe("TRUST_CONFIG_NOT_GLOBAL");
    // The rejection names auth, proving it came from the pre-existing branch.
    expect(err.message).toContain("auth");
  });
});