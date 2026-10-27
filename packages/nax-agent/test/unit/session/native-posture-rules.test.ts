import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { nativePostureRules } from "#src/session/native-posture-rules";
import { assertNaxError } from "#test/helpers/index";

describe("nativePostureRules", () => {
  test.each(["none", "read"] as const)("AC-9/10/21: %s refuses tool-only overlays even when empty", (profile) => {
    for (const option of ["askRules", "denyRules"] as const) {
      for (const value of [[], ["Write"]]) {
        let caught: unknown;
        try {
          nativePostureRules(profile, { model: "openai/x", [option]: value });
        } catch (err) {
          caught = err;
        }
        assertNaxError(caught);
        expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
        expect(caught.message).toContain(`backend.${option}`);
      }
    }
  });

  test("AC-11: parses review's Bash ask expression", () => {
    expect(nativePostureRules("review", { model: "openai/x", askRules: ["Bash(git push*)"] }).askRules).toEqual([
      { tool: "Bash", patterns: ["git push*"] },
    ]);
  });

  test("AC-12/13: absent overlays are empty and sandbox defaults remain unchanged", () => {
    expect(nativePostureRules("full", { model: "openai/x" })).toEqual({
      askRules: [],
      denyRules: [],
      sandbox: DEFAULT_SANDBOX_CONFIG,
    });
  });

  test("parses denies and fills a partial sandbox without mutating input", () => {
    const raw = {
      model: "openai/x",
      denyRules: ["Delete(keep/**)"],
      sandbox: { network: { allowedDomains: ["registry.npmjs.org"] } },
    };
    const result = nativePostureRules("full", raw);
    expect(result.denyRules).toEqual([{ tool: "Delete", patterns: ["keep/**"] }]);
    expect(result.sandbox.enabled).toBe(DEFAULT_SANDBOX_CONFIG.enabled);
    expect(result.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(raw.sandbox).not.toHaveProperty("enabled");
  });
});
