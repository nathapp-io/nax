import { describe, expect, it } from "vitest";
import { AuthMethodUnavailableError, LoginCancelledError, LoginFailedError } from "../../src/auth/login-errors.ts";

describe("login errors", () => {
  it("names the provider when no method is available", () => {
    const error = new AuthMethodUnavailableError("acme");
    expect(error.name).toBe("AuthMethodUnavailableError");
    expect(error.providerId).toBe("acme");
    expect(error.requested).toBeUndefined();
    expect(error.message).toMatch(/acme/);
  });

  it("distinguishes a requested method that is unavailable", () => {
    const error = new AuthMethodUnavailableError("acme", "oauth");
    expect(error.requested).toBe("oauth");
    expect(error.message).toMatch(/oauth/);
  });

  it("reports cancellation as its own error, not a failure", () => {
    const error = new LoginCancelledError("acme");
    expect(error.name).toBe("LoginCancelledError");
    expect(error).not.toBeInstanceOf(LoginFailedError);
  });

  it("carries the reason a login failed", () => {
    const error = new LoginFailedError("acme", "the flow returned no credential");
    expect(error.name).toBe("LoginFailedError");
    expect(error.message).toMatch(/returned no credential/);
  });
});
