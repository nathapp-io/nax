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
  test.each([
    [
      "AC-13 absolute exemption",
      "/repo/.nax/features/f/workflow/r/US-001/report.md",
      "/repo/.nax/features/f/workflow/r/US-001/report.md",
    ],
    ["AC-14 relative exemption", "out/report.md", "/repo/out/report.md"],
    ["AC-15 omitted exemption", undefined, undefined],
  ])("%s", async (_name, exemption, expected) => {
    const roots: string[] = [];
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend: makeFakeSandboxBackend(),
      policyFor: async (root) => {
        roots.push(root);
        return POLICY;
      },
    });
    const result = await sessionSandboxFrom(launcher, "/repo", exemption);
    expect(result).toEqual({
      kind: "policy",
      policy: POLICY,
      ...(expected === undefined ? {} : { writeExemption: expected }),
    });
    expect(roots).toEqual(["/repo"]);
    if (expected === undefined) expect(result).not.toHaveProperty("writeExemption");
  });

  test("AC-16 unavailable omits the exemption", async () => {
    const launcher = createCommandLauncher({ state: { kind: "unavailable", backend: "srt", reason: "no bwrap" } });
    const result = await sessionSandboxFrom(launcher, "/repo", "/repo/report.md");
    expect(result).toEqual({ kind: "unavailable", reason: "no bwrap" });
    expect(result).not.toHaveProperty("writeExemption");
  });

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
