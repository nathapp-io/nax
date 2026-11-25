/**
 * #3038 -- the session sandbox hands the policy the nested mandatory names found beneath
 * its root (Linux), read per build like every other entry, and never asks on darwin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _launcherDeps,
  _sessionSandboxDeps,
  DEFAULT_SANDBOX_CONFIG,
  EMPTY_OWNED_PATHS_POLICY,
  resolveSessionSandbox,
} from "@nathapp/nax-agent/internal";
import {
  assertDefined,
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  testProtectedPaths,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

const enabled = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };

describe("resolveSessionSandbox -- nested mandatory denies (#3038)", () => {
  withDepsRestore(_sessionSandboxDeps);
  withDepsRestore(_launcherDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  let root: string;
  beforeEach(() => {
    root = makeTempDir("session-sbx-nested-");
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  });
  afterEach(() => cleanupTempDir(root));

  async function wrappedDenyWrite(platform: NodeJS.Platform, asked: string[]): Promise<readonly string[]> {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps, { platform });
    _sessionSandboxDeps.nestedMandatoryDenies = async (r) => {
      asked.push(r);
      return [`${r}/sub/.mcp.json`, `${r}/sub/.vscode`];
    };
    const launcher = await resolveSessionSandbox({
      config: enabled,
      root,
      needsLauncher: true,
      protectedPaths: testProtectedPaths(),
      ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    });
    await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    const call = seam.backend.calls[0];
    assertDefined(call, "the request backend.wrap received");
    return call.policy.denyWrite;
  }

  test("linux: the root's nested names are in the wrapped policy's denyWrite", async () => {
    const asked: string[] = [];
    const denyWrite = await wrappedDenyWrite("linux", asked);
    expect(denyWrite.some((p) => p.endsWith("/sub/.mcp.json"))).toBe(true);
    expect(denyWrite.some((p) => p.endsWith("/sub/.vscode"))).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
  });

  test("darwin: the scan is never asked for (the backend adds patterns instead)", async () => {
    const asked: string[] = [];
    const denyWrite = await wrappedDenyWrite("darwin", asked);
    expect(asked).toEqual([]);
    expect(denyWrite.some((p) => p.endsWith("/sub/.mcp.json"))).toBe(false);
  });
});
