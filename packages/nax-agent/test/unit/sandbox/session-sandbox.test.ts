import { describe, expect, test } from "bun:test";
import { createCommandLauncher, DISABLED_SANDBOX_STATE, type SandboxPolicy } from "#src/sandbox/index";
import { sessionSandboxFrom } from "#src/sandbox/session-sandbox";
import { makeFakeSandboxBackend } from "#test/helpers/index";

const POLICY: SandboxPolicy = {
  writeRoots: ["/r"],
  denyWrite: ["/r/.git/hooks"],
  denyRead: ["/home/u/.nax/credentials"],
  network: {},
};

describe("sessionSandboxFrom (nax#2500)", () => {
  test("no launcher or a disabled one: no sandbox", async () => {
    expect(await sessionSandboxFrom(undefined, "/r")).toBeUndefined();
    expect(await sessionSandboxFrom(createCommandLauncher({ state: DISABLED_SANDBOX_STATE }), "/r")).toBeUndefined();
  });

  test("unavailable: the reason", async () => {
    const launcher = createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
    expect(await sessionSandboxFrom(launcher, "/r")).toEqual({ kind: "unavailable", reason: "no bwrap" });
  });

  test("available: the policy built for the root, without the session TMPDIR", async () => {
    const seen: [string, boolean][] = [];
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend: makeFakeSandboxBackend(),
      policyFor: async (root, tmpDirInForce) => {
        seen.push([root, tmpDirInForce]);
        return POLICY;
      },
    });
    expect(await sessionSandboxFrom(launcher, "/r")).toEqual({ kind: "policy", policy: POLICY });
    expect(seen).toEqual([["/r", false]]);
  });
});
