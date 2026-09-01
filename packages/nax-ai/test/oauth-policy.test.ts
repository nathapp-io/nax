/**
 * Gate: the Anthropic OAuth flow must never become registrable.
 *
 * This is the single chokepoint that justifies routing all provider access
 * through this package. The underlying client bundles Anthropic's flow beside
 * permitted ones behind a shared lazy loader, so "we just won't call it" is a
 * convention; this file is the enforcement.
 *
 * If a future change makes these fail, that is the gate working. Anthropic
 * subscription OAuth outside the official CLI is server-blocked and a ToS
 * violation — the fix is never to add it to the allowlist.
 */

import { describe, expect, it } from "vitest";
import {
  assertOAuthFlowPermitted,
  isOAuthFlowPermitted,
  OAuthFlowProhibitedError,
  PERMITTED_OAUTH_FLOWS,
  PROHIBITED_OAUTH_FLOWS,
} from "../src/auth/oauth-policy.ts";

describe("oauth policy", () => {
  it("does not permit the anthropic flow", () => {
    expect(isOAuthFlowPermitted("anthropic")).toBe(false);
    expect(PERMITTED_OAUTH_FLOWS).not.toContain("anthropic");
  });

  it("throws a specific error for the anthropic flow, with a reason", () => {
    expect(() => assertOAuthFlowPermitted("anthropic")).toThrow(OAuthFlowProhibitedError);
    expect(() => assertOAuthFlowPermitted("anthropic")).toThrow(/ToS violation/i);
  });

  it("records why anthropic is prohibited so the omission is not 'fixed' later", () => {
    expect(PROHIBITED_OAUTH_FLOWS.anthropic).toMatch(/server-blocked/i);
  });

  it("permits the codex flow, which is in scope", () => {
    expect(isOAuthFlowPermitted("openai-codex")).toBe(true);
    expect(() => assertOAuthFlowPermitted("openai-codex")).not.toThrow();
  });

  it("distinguishes a prohibited flow from an unknown one", () => {
    // A typo should not masquerade as a policy breach, or the error text sends
    // the reader to the wrong problem.
    expect(() => assertOAuthFlowPermitted("openai-codexx")).toThrow(/Unknown OAuth flow/);
    expect(() => assertOAuthFlowPermitted("openai-codexx")).not.toThrow(OAuthFlowProhibitedError);
  });

  it("keeps the allowlist immutable at runtime", () => {
    expect(Object.isFrozen(PERMITTED_OAUTH_FLOWS)).toBe(true);
    expect(Object.isFrozen(PROHIBITED_OAUTH_FLOWS)).toBe(true);
  });

  it("does not permit the github-copilot flow", () => {
    expect(isOAuthFlowPermitted("github-copilot")).toBe(false);
    expect(PERMITTED_OAUTH_FLOWS).not.toContain("github-copilot");
  });

  it("records why github-copilot is not cleared, and does not overstate it", () => {
    // The reason must survive, or a future reader restores the entry as an
    // oversight. It must also not claim a ToS violation we have not
    // established — that is anthropic's case, not this one.
    expect(PROHIBITED_OAUTH_FLOWS["github-copilot"]).toMatch(/not cleared/i);
    expect(PROHIBITED_OAUTH_FLOWS["github-copilot"]).not.toMatch(/ToS violation/i);
  });

  it("still permits openrouter", () => {
    expect(isOAuthFlowPermitted("openrouter")).toBe(true);
    expect(() => assertOAuthFlowPermitted("openrouter")).not.toThrow();
  });
});
