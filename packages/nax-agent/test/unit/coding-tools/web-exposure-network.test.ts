import { afterEach, expect, mock, test } from "bun:test";
import { _sessionSandboxDeps, resolveSessionSandbox } from "#src/coding-tools/coding-tool-sandbox";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import { createWebExposure } from "#src/web/exposure";
import { createWebExposureGuard } from "#src/web/guard";
import {
  stubSessionSandboxDeps,
  testProtectedPaths,
  waitForCondition,
  withDepsRestore,
  withWarnSpy,
} from "#test/helpers/index";

withDepsRestore(_sessionSandboxDeps);
afterEach(() => mock.restore());

async function fixture(available: boolean, reject = false) {
  const { backend } = stubSessionSandboxDeps(_sessionSandboxDeps);
  _sessionSandboxDeps.probe = async () =>
    available ? { available: true } : { available: false, reason: "no sandbox" };
  const calls: string[][] = [];
  backend.updateNetwork = async (domains) => {
    calls.push([...domains]);
    if (reject) throw new Error("swap failed");
  };
  const exposure = createWebExposure();
  const port = createWebExposureGuard({
    exposure,
    configuredAllowedDomains: undefined,
    exposedAllowedDomains: ["registry.npmjs.org"],
  });
  const launcher = await resolveSessionSandbox({
    config: DEFAULT_SANDBOX_CONFIG,
    root: "/repo",
    needsLauncher: true,
    protectedPaths: testProtectedPaths(),
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    webExposure: port,
  });
  return { calls, exposure, launcher };
}

test("AC-11: available sandbox swaps its backend network once on exposure", async () => {
  const { calls, exposure, launcher } = await fixture(true);
  expect(launcher.state.kind).toBe("available");
  expect(calls).toEqual([]);
  exposure.markExposed(new Date(0));
  exposure.markExposed(new Date(1));
  expect(calls).toEqual([["registry.npmjs.org"]]);
});
test("AC-12: unavailable sandbox never registers a network swap", async () => {
  await withWarnSpy(async () => {
    const { calls, exposure, launcher } = await fixture(false);
    expect(launcher.state.kind).toBe("unavailable");
    exposure.markExposed(new Date(0));
    expect(calls).toEqual([]);
  });
});
test("AC-13: rejected network swap warns once and exposure does not throw", async () => {
  await withWarnSpy(async (warn) => {
    const { calls, exposure } = await fixture(true, true);
    expect(() => exposure.markExposed(new Date(0))).not.toThrow();
    await waitForCondition(() => warn.mock.calls.length === 1);
    expect(calls).toEqual([["registry.npmjs.org"]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[2]).toMatchObject({ error: "swap failed" });
  });
});
