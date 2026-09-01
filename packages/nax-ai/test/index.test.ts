import { describe, expect, it } from "vitest";
import * as naxAi from "../src/index.ts";

describe("public surface", () => {
  it("exports login and its errors", () => {
    expect(typeof naxAi.login).toBe("function");
    expect(typeof naxAi.AuthMethodUnavailableError).toBe("function");
    expect(typeof naxAi.LoginCancelledError).toBe("function");
    expect(typeof naxAi.LoginFailedError).toBe("function");
  });

  it("does not export the test seams", () => {
    // A seam on the public surface becomes something consumers depend on.
    expect(naxAi).not.toHaveProperty("_loginDeps");
    expect(naxAi).not.toHaveProperty("_resolveTarget");
  });
});
