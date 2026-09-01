import { describe, expect, it } from "vitest";
import { registerBundledOAuthFlows, resolveLoginTarget } from "../../src/auth/pi-auth.ts";

/**
 * Gate: registering the bundled OAuth flow loaders must not make a
 * prohibited flow reachable.
 *
 * registerBundledOAuthFlows() makes every pi-ai OAuth flow module statically
 * present (no more lazy, unbundlable load). Before this existed, a prohibited
 * flow like anthropic's was additionally protected by simply never being
 * loaded in most processes. That protection is gone once flows are bundled,
 * so this pins the ACTUAL enforcement: resolveLoginTarget only ever exposes
 * an oauth runner for a provider that passes isOAuthFlowPermitted
 * (oauth-policy.ts), regardless of whether the underlying loader is ready.
 *
 * Deliberately unmocked and against pi-ai's real provider catalog (not the
 * `_loginDeps` test seam used elsewhere in this suite) and the real
 * "@earendil-works/pi-ai/bun-oauth" subpath, so this proves the real
 * production wiring, not a stand-in.
 */
describe("OAuth policy under bundled registration", () => {
  it("still refuses to expose the anthropic oauth flow after registration", async () => {
    await registerBundledOAuthFlows();

    const target = await resolveLoginTarget("anthropic");

    expect(target.oauth).toBeUndefined();
    // api-key stays available: the policy blocks the subscription OAuth flow
    // specifically, not the provider entirely.
    expect(target.apiKey).toBeDefined();
  });

  it("still refuses to expose the github-copilot oauth flow after registration", async () => {
    await registerBundledOAuthFlows();

    const target = await resolveLoginTarget("github-copilot");

    expect(target.oauth).toBeUndefined();
  });

  it("still exposes a permitted oauth flow after registration", async () => {
    await registerBundledOAuthFlows();

    const target = await resolveLoginTarget("openai-codex");

    expect(target.oauth).toBeDefined();
  });
});
