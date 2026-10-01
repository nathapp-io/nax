import { describe, expect, it, vi } from "vitest";

/**
 * Pins that the memo caches the success and not the failure.
 *
 * Its own file because the memo is module-level state: the companion
 * success-path test consumes it, and vitest isolates modules per file.
 */
const registerBunOAuthFlows = vi.fn();
vi.mock("@earendil-works/pi-ai/bun-oauth", () => ({
  registerBunOAuthFlows,
}));

const { registerBundledOAuthFlows } = await import("../../src/auth/pi-auth.ts");

describe("registerBundledOAuthFlows failure handling", () => {
  it("does not cache a rejection: a later call retries and can succeed", async () => {
    registerBunOAuthFlows.mockImplementationOnce(() => {
      throw new Error("import failed");
    });

    await expect(registerBundledOAuthFlows()).rejects.toThrow("import failed");

    // Without dropping the memo this would reject forever, and every login in
    // the process would fail on an error that had already passed.
    await expect(registerBundledOAuthFlows()).resolves.toBeUndefined();
    expect(registerBunOAuthFlows).toHaveBeenCalledTimes(2);

    // Having succeeded, it is memoised again.
    await registerBundledOAuthFlows();
    expect(registerBunOAuthFlows).toHaveBeenCalledTimes(2);
  });
});
