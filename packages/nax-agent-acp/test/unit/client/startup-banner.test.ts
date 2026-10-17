import { describe, expect, test } from "bun:test";
import { startupBannerOf } from "#src/client/startup-banner";

describe("startupBannerOf (nax#2591)", () => {
  test("pi-acp's _meta.piAcp.startupInfo is the banner", () => {
    expect(startupBannerOf({ sessionId: "s", _meta: { piAcp: { startupInfo: "pi v0.84.3\n" } } })).toBe("pi v0.84.3\n");
  });

  test.each<unknown>([
    undefined,
    "text",
    { sessionId: "s" },
    { _meta: null },
    { _meta: { piAcp: "x" } },
    { _meta: { piAcp: { startupInfo: null } } },
    { _meta: { piAcp: { startupInfo: "" } } },
    { _meta: { piAcp: { startupInfo: 7 } } },
  ])("no banner in %p", (response) => {
    expect(startupBannerOf(response)).toBeUndefined();
  });
});
