import { describe, expect, it, vi } from "vitest";

/**
 * Verifies registerBundledOAuthFlows() reaches pi-ai's bundler-safe loader
 * registration through the literal "@earendil-works/pi-ai/bun-oauth"
 * specifier, and that repeat/concurrent calls register only once.
 *
 * The module under test is mocked at the exact literal specifier
 * registerBundledOAuthFlows imports — if that import ever stopped being a
 * literal (e.g. built from a variable), this mock would no longer apply and
 * this test would exercise the real module instead of failing loudly, so the
 * companion policy test (pi-auth-oauth-policy-registration.test.ts) pins the
 * real, unmocked subpath too.
 */
const registerBunOAuthFlows = vi.fn();
vi.mock("@earendil-works/pi-ai/bun-oauth", () => ({
  registerBunOAuthFlows,
}));

const { registerBundledOAuthFlows } = await import("../../src/auth/pi-auth.ts");

describe("registerBundledOAuthFlows", () => {
  it("calls registerBunOAuthFlows via the literal bun-oauth subpath, once, even for concurrent and repeat callers", async () => {
    const [a, b] = await Promise.all([registerBundledOAuthFlows(), registerBundledOAuthFlows()]);
    await registerBundledOAuthFlows();

    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(registerBunOAuthFlows).toHaveBeenCalledTimes(1);
  });
});
