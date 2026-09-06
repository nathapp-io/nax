/**
 * US-004 — planCommand claims the project identity before dispatching plan work.
 *
 * Every `nax plan` entry point routes through planCommand, so one claim at the
 * top of planCommand covers every plan mode. Tests drive planCommand end-to-end
 * (claim → context build → strategy execute) with a mocked runtime and assert
 * the observable claim behaviour:
 *   - projectKey derivation (trimmed config.name, else basename(workdir))
 *   - remoteUrl derivation from `_planDeps.spawnSync` (trimmed or null)
 *   - RUN_NAME_COLLISION propagated, with the plan strategy never invoked
 *   - non-collision claim failures warn-and-proceed
 *   - real identity file writes/updates against the isolated global config dir
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertNaxError, makeMockAgentManager, makeMockRuntime, makeTempDir } from "@test/helpers";
import { _planDeps, planCommand } from "@/cli";
import { DEFAULT_CONFIG, globalConfigDir, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { readProjectIdentity } from "@/runtime";

const SAMPLE_SPEC = `# Feature: URL Shortener
## Problem
Need a way to shorten URLs.
## Acceptance Criteria
- AC-1: Shorten URL
- AC-2: Redirect to original
`;

const SAMPLE_PRD = {
  project: "auto-detected",
  feature: "url-shortener",
  branchName: "feat/url-shortener",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Shorten URL",
      description: "User can shorten a long URL",
      acceptanceCriteria: ["AC-1: Returns shortened URL"],
      tags: ["feature"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "Single function, clear output",
      },
    },
  ],
};

interface ClaimCall {
  projectKey: string;
  workdir: string;
  remoteUrl: string | null;
}

describe("planCommand — US-004 project identity claim", () => {
  let tmpDir: string;
  let dispatchCount: number;
  let capturedWrites: Array<[string, string]>;
  /** Claimed identity keys touched this test — removed in afterEach. */
  const claimedKeys = new Set<string>();

  const origReadFile = _planDeps.readFile;
  const origWriteFile = _planDeps.writeFile;
  const origScanSourceRoots = _planDeps.scanSourceRoots;
  const origCreateRuntime = _planDeps.createRuntime;
  const origReadPackageJson = _planDeps.readPackageJson;
  const origSpawnSync = _planDeps.spawnSync;
  const origMkdirp = _planDeps.mkdirp;
  const origExistsSync = _planDeps.existsSync;
  const origClaimProjectIdentity = _planDeps.claimProjectIdentity;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-identity-");
    dispatchCount = 0;
    capturedWrites = [];
    claimedKeys.clear();

    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    _planDeps.readFile = mock(async (path: string) => {
      if (path.endsWith("prd.json")) return JSON.stringify(SAMPLE_PRD);
      return SAMPLE_SPEC;
    });
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWrites.push([path, content]);
    });
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax") || path.endsWith("prd.json"));
    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "my-project" }));
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => {
            dispatchCount += 1;
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify(SAMPLE_PRD),
                rateLimited: false,
                durationMs: 1,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          },
        }),
      }),
    );
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.claimProjectIdentity = origClaimProjectIdentity;
    for (const key of claimedKeys) {
      await rm(join(globalConfigDir(), key), { recursive: true, force: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** Restore the real runtime claim (preload-isolated global dir) and track the key's cleanup. */
  function useRealClaim(projectKey: string): void {
    _planDeps.claimProjectIdentity = origClaimProjectIdentity;
    claimedKeys.add(projectKey);
  }

  /** Install a recording spy; capture every call while delegating to the given impl. */
  function spyClaim(impl: (projectKey: string, workdir: string, remoteUrl: string | null) => Promise<void>) {
    const calls: ClaimCall[] = [];
    _planDeps.claimProjectIdentity = mock(async (projectKey: string, workdir: string, remoteUrl: string | null) => {
      calls.push({ projectKey, workdir, remoteUrl });
      await impl(projectKey, workdir, remoteUrl);
    });
    return { spy: _planDeps.claimProjectIdentity, calls };
  }

  test("AC-1/AC-2 (US-004): rejects with RUN_NAME_COLLISION and never invokes the plan strategy when the claim targets a different workdir", async () => {
    const projectKey = "ac1-collision";
    useRealClaim(projectKey);
    // Pre-register the key under a DIFFERENT workdir using the real runtime claim.
    await origClaimProjectIdentity(projectKey, "/tmp/some-other-checkout", null);

    const err = await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    }).catch((e) => e);

    assertNaxError(err, "planCommand collision rejection");
    expect(err.code).toBe("RUN_NAME_COLLISION");
    // Strategy execute must never run: no runtime was created, no agent dispatch, no PRD write.
    expect(_planDeps.createRuntime).not.toHaveBeenCalled();
    expect(dispatchCount).toBe(0);
    expect(capturedWrites.length).toBe(0);
  });

  test("AC-3 (US-004): when no identity exists, writes an identity with workdir equal to the workdir argument and invokes the strategy once", async () => {
    const projectKey = "ac3-first-claim";
    useRealClaim(projectKey);

    const result = await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    const identity = await readProjectIdentity(projectKey);
    expect(identity).not.toBeNull();
    expect(identity?.workdir).toBe(tmpDir);
    expect(identity?.name).toBe(projectKey);
    expect(dispatchCount).toBe(1);
    expect(result.outputPath).toBe(join(tmpDir, ".nax", "features", "url-shortener", "prd.json"));
  });

  test("AC-4 (US-004): when the identity is already registered to the same workdir, invokes the strategy once and updates lastSeen", async () => {
    const projectKey = "ac4-reclaim-same";
    useRealClaim(projectKey);
    await origClaimProjectIdentity(projectKey, tmpDir, null);
    const before = await readProjectIdentity(projectKey);
    expect(before?.workdir).toBe(tmpDir);
    // Ensure the clock advances so lastSeen is observably refreshed.
    await new Promise((r) => setTimeout(r, 5));

    await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    const after = await readProjectIdentity(projectKey);
    expect(after?.workdir).toBe(tmpDir);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.lastSeen).not.toBe(before?.lastSeen);
    expect(dispatchCount).toBe(1);
  });

  test("AC-5 (US-004): claims under the trimmed config.name when config.name is a non-empty string", async () => {
    const projectKey = "ac5-trimmed-name";
    const { spy, calls } = spyClaim(async () => {});

    await planCommand(tmpDir, makeConfigWithName(`  ${projectKey}  `), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0]?.projectKey).toBe(projectKey); // trimmed — no surrounding whitespace
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(dispatchCount).toBe(1);
  });

  test("AC-6 (US-004): claims under basename(workdir) when config.name is absent or whitespace-only", async () => {
    const { spy, calls } = spyClaim(async () => {});
    const expectedKey = basename(tmpDir);

    for (const name of ["", "   "]) {
      await planCommand(tmpDir, makeConfigWithName(name), {
        from: join(tmpDir, "spec.md"),
        feature: "url-shortener",
      });
    }

    expect(spy).toHaveBeenCalledTimes(2);
    expect(calls[0]?.projectKey).toBe(expectedKey);
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(calls[1]?.projectKey).toBe(expectedKey);
    expect(calls[1]?.workdir).toBe(tmpDir);
    expect(dispatchCount).toBe(2);
  });

  test("AC-7 (US-004): passes the trimmed origin remote URL as remoteUrl when spawnSync exits 0", async () => {
    const projectKey = "ac7-remote-url";
    _planDeps.spawnSync = mock(() => ({
      stdout: Buffer.from("  https://github.com/org/repo-name.git\n"),
      exitCode: 0,
    }));
    const { calls } = spyClaim(async () => {});

    await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(_planDeps.spawnSync).toHaveBeenCalledWith(["git", "remote", "get-url", "origin"], { cwd: tmpDir });
    expect(calls[0]?.projectKey).toBe(projectKey);
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(calls[0]?.remoteUrl).toBe("https://github.com/org/repo-name.git"); // trimmed
  });

  test("AC-8 (US-004): passes null as remoteUrl when spawnSync reports a non-zero exit code", async () => {
    const projectKey = "ac8-null-remote";
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 128 }));
    const { calls } = spyClaim(async () => {});

    await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(calls[0]?.projectKey).toBe(projectKey);
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(calls[0]?.remoteUrl).toBeNull();
    expect(dispatchCount).toBe(1);
  });

  test("AC-9 (US-004): when the claim rejects with a non-RUN_NAME_COLLISION error, invokes the strategy once and resolves", async () => {
    const projectKey = "ac9-warn-proceed";
    const { spy, calls } = spyClaim(async () => {
      throw new NaxError("Disk write failed", "IDENTITY_WRITE_FAILED", { stage: "plan" });
    });

    const result = await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
    expect(dispatchCount).toBe(1);
    expect(result.outputPath).toBe(join(tmpDir, ".nax", "features", "url-shortener", "prd.json"));
  });
});

function makeConfigWithName(name: string): NaxConfig {
  return { ...DEFAULT_CONFIG, name };
}
