import { describe, expect, test } from "bun:test";
import { claudeSandboxOptions } from "#src/client/claude-sandbox";

describe("claudeSandboxOptions (nax#2500)", () => {
  const base = { writeRoots: ["/r", "/tmp/nax/run"], denyWrite: ["/r/.git/hooks"], denyRead: ["/h/.nax/creds"] };

  test("open network: no network key, every lock set", () => {
    expect(claudeSandboxOptions({ ...base, network: {} })).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: ["/r", "/tmp/nax/run"], denyWrite: ["/r/.git/hooks"], denyRead: ["/h/.nax/creds"] },
    });
  });

  test("allow-list network: passed through", () => {
    expect(claudeSandboxOptions({ ...base, network: { allowedDomains: ["pypi.org"] } }).network).toEqual({
      allowedDomains: ["pypi.org"],
    });
  });

  test("an empty allow-list is kept (no network)", () => {
    expect(claudeSandboxOptions({ ...base, network: { allowedDomains: [] } }).network).toEqual({ allowedDomains: [] });
  });
});
