import { describe, expect, test } from "bun:test";
import { makeFakeSandboxBackend } from "@test/helpers";
import { probeSandbox } from "@/sandbox";

describe("probeSandbox", () => {
  test("available when the allowed write lands and the denied write does not", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    expect(await probeSandbox(backend)).toEqual({ available: true });
    expect(backend.finished).toBe(1);
  });

  test("the denied marker is a literal entry in denyWrite (deny-within-allow), not merely outside the roots", async () => {
    const backend = makeFakeSandboxBackend("enforce");
    await probeSandbox(backend);
    const req = backend.calls[0];
    expect(req?.policy.denyWrite.some((p) => p.endsWith("/denied/marker"))).toBe(true);
    expect(req?.policy.writeRoots.length).toBe(1);
  });

  test("a sandbox that runs but does not enforce is UNAVAILABLE, never available", async () => {
    const result = await probeSandbox(makeFakeSandboxBackend("leak"));
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("did not enforce");
  });

  test("F4: a sandbox that cannot run a command is unavailable and says why", async () => {
    const result = await probeSandbox(makeFakeSandboxBackend("cannot-run"));
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("Can't mount proc");
  });

  test("a wrap that throws is unavailable", async () => {
    const result = await probeSandbox(makeFakeSandboxBackend("throw"));
    expect(result).toEqual({ available: false, reason: "sandbox wrap failed: fake wrap failure" });
  });

  test("an unsupported platform is unavailable without wrapping", async () => {
    const backend = makeFakeSandboxBackend("unsupported");
    const result = await probeSandbox(backend);
    expect(result.available).toBe(false);
    expect(backend.calls.length).toBe(0);
  });
});
