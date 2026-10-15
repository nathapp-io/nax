/**
 * US-002 — `execution.sandbox.network.allowLocalBinding` (#2538).
 *
 * srt reads the flag ONCE per process, from the config handed to
 * `SandboxManager.initialize` (`getAllowLocalBinding`, sandbox-manager.js:1171)
 * and never from the per-command `customConfig` given to `wrapWithSandboxArgv`.
 * Both halves are pinned here: the flag reaches `initialize`, and no custom
 * config ever carries it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig, SandboxConfigSchema } from "#src/config/schemas-sandbox";
import { realOrRaw } from "#src/internal/realpath";
import {
  _srtBackendDeps,
  buildSandboxPolicy,
  createSrtBackend,
  type SandboxNetworkPolicy,
  type SandboxPolicyInput,
  type SandboxWrapRequest,
} from "#src/sandbox/index";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

type SrtModuleSlice = Awaited<ReturnType<typeof _srtBackendDeps.load>>;
type SrtInitializeConfig = Parameters<SrtModuleSlice["SandboxManager"]["initialize"]>[0];
type SrtWrapArgs = Parameters<SrtModuleSlice["SandboxManager"]["wrapWithSandboxArgv"]>;

describe("US-002 execution.sandbox.network.allowLocalBinding (schema)", () => {
  test("AC-1: parse({}) yields a network with no allowLocalBinding value", () => {
    const network = SandboxConfigSchema.parse({}).network;

    expect("allowLocalBinding" in network).toBe(false);
    expect(network.allowLocalBinding).toBeUndefined();
  });

  test("AC-2: allowLocalBinding: true survives parsing and leaves allowedDomains absent", () => {
    const network = SandboxConfigSchema.parse({ network: { allowLocalBinding: true } }).network;

    expect(network.allowLocalBinding).toBe(true);
    expect(network.allowedDomains).toBeUndefined();
  });

  test("AC-2 boundary: an explicit false parses and stays false", () => {
    expect(SandboxConfigSchema.parse({ network: { allowLocalBinding: false } }).network.allowLocalBinding).toBe(false);
  });
});

describe("US-002 buildSandboxPolicy network", () => {
  let base: string;
  let root: string;
  let home: string;

  beforeEach(() => {
    base = realOrRaw(makeTempDir("sbx-loopback-"));
    root = join(base, "repo");
    home = join(base, "home");
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
  });
  afterEach(() => cleanupTempDir(base));

  function input(config: SandboxConfig): SandboxPolicyInput {
    return {
      root,
      git: { kind: "main", gitDir: join(root, ".git") },
      gitGuardFiles: [],
      naxEntries: [],
      ownedPaths: EMPTY_OWNED_PATHS_POLICY,
      credentialFiles: [],
      home,
      tempRoots: [],
      platform: "linux",
      config,
    };
  }

  function config(network: SandboxConfig["network"]): SandboxConfig {
    return { ...DEFAULT_SANDBOX_CONFIG, network };
  }

  test("AC-3: the allow-list and the loopback flag both reach the policy, and nothing else does", () => {
    const policy = buildSandboxPolicy(
      input(config({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true })),
    );

    expect(policy.network).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true });
  });

  test("AC-4: loopback alone reaches the policy with no allowedDomains key", () => {
    const policy = buildSandboxPolicy(input(config({ allowLocalBinding: true })));

    expect(policy.network).toEqual({ allowLocalBinding: true });
  });

  test("AC-5: the default network carries no allowLocalBinding key", () => {
    const policy = buildSandboxPolicy(input(DEFAULT_SANDBOX_CONFIG));

    expect(policy.network).toEqual({});
    expect("allowLocalBinding" in policy.network).toBe(false);
  });

  test("AC-5 boundary: an explicit false leaves the policy with no allowLocalBinding key", () => {
    const policy = buildSandboxPolicy(input(config({ allowedDomains: ["x.test"], allowLocalBinding: false })));

    expect(policy.network).toEqual({ allowedDomains: ["x.test"] });
  });
});

describe("US-002 createSrtBackend initialize network", () => {
  const realLoad = _srtBackendDeps.load;
  const realMkdir = _srtBackendDeps.mkdir;

  afterEach(() => {
    _srtBackendDeps.load = realLoad;
    _srtBackendDeps.mkdir = realMkdir;
  });

  /** The stub is typed as the seam's own slice, so no cast is needed. */
  function installSrtStub(): { initialize: SrtInitializeConfig[]; wrap: SrtWrapArgs[] } {
    const initialize: SrtInitializeConfig[] = [];
    const wrap: SrtWrapArgs[] = [];
    _srtBackendDeps.load = async () => ({
      SandboxManager: {
        initialize: async (config) => {
          initialize.push(config);
        },
        isSupportedPlatform: () => true,
        wrapWithSandboxArgv: async (...args) => {
          wrap.push(args);
          return { argv: ["/bin/sh", "-c", "true"], env: {} };
        },
        annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
        cleanupAfterCommand: () => {},
        reset: async () => {},
      },
    });
    // Never create srt's real `/tmp/claude` from a test: the network config
    // under test is unaffected, and the write lands outside this run's roots.
    _srtBackendDeps.mkdir = async () => undefined;
    return { initialize, wrap };
  }

  function wrapRequest(network: SandboxNetworkPolicy): SandboxWrapRequest {
    return {
      command: "true",
      shell: "/bin/sh",
      policy: { writeRoots: [process.cwd()], denyWrite: [], denyRead: [], network },
      cwd: process.cwd(),
      commandId: "us-002",
    };
  }

  test("AC-6: the first wrap initializes srt with the allow-list and allowLocalBinding: true", async () => {
    const stub = installSrtStub();
    const backend = createSrtBackend({ allowedDomains: ["x.test"], allowLocalBinding: true });

    await backend.wrap(wrapRequest({ allowedDomains: ["x.test"], allowLocalBinding: true }));

    expect(stub.initialize).toHaveLength(1);
    const initialized = stub.initialize[0];
    expect(initialized?.network.allowLocalBinding).toBe(true);
    expect(initialized?.network.allowedDomains).toEqual(["x.test"]);
  });

  test("AC-6 boundary: initialize runs once however many commands are wrapped", async () => {
    const stub = installSrtStub();
    const backend = createSrtBackend({ allowedDomains: ["x.test"], allowLocalBinding: true });

    await backend.wrap(wrapRequest({ allowedDomains: ["x.test"], allowLocalBinding: true }));
    await backend.wrap(wrapRequest({ allowedDomains: ["x.test"], allowLocalBinding: true }));

    expect(stub.wrap).toHaveLength(2);
    expect(stub.initialize).toHaveLength(1);
  });

  test("AC-7: loopback alone initializes the open network plus allowLocalBinding: true", async () => {
    const stub = installSrtStub();
    const backend = createSrtBackend({ allowLocalBinding: true });

    await backend.wrap(wrapRequest({ allowLocalBinding: true }));

    const network = stub.initialize[0]?.network;
    expect("allowedDomains" in (network ?? {})).toBe(false);
    expect(network?.allowLocalBinding).toBe(true);
  });

  test("AC-8: an allow-list without the flag initializes a network with no allowLocalBinding key", async () => {
    const stub = installSrtStub();
    const backend = createSrtBackend({ allowedDomains: ["x.test"] });

    await backend.wrap(wrapRequest({ allowedDomains: ["x.test"] }));

    const network = stub.initialize[0]?.network;
    expect("allowLocalBinding" in (network ?? {})).toBe(false);
    expect(network?.allowedDomains).toEqual(["x.test"]);
  });

  test("AC-9: the per-command customConfig carries no allowLocalBinding with an allow-list", async () => {
    const stub = installSrtStub();
    const backend = createSrtBackend({ allowedDomains: ["x.test"], allowLocalBinding: true });

    await backend.wrap(wrapRequest({ allowedDomains: ["x.test"], allowLocalBinding: true }));

    expect(stub.wrap[0]?.[2]).toEqual({
      filesystem: { denyRead: [], allowWrite: [process.cwd()], denyWrite: [] },
      network: { allowedDomains: ["x.test"], deniedDomains: [] },
    });
  });

  test("AC-9 boundary: loopback alone adds no network block to the customConfig at all", async () => {
    const stub = installSrtStub();
    const backend = createSrtBackend({ allowLocalBinding: true });

    await backend.wrap(wrapRequest({ allowLocalBinding: true }));

    expect(stub.wrap[0]?.[2]).toEqual({
      filesystem: { denyRead: [], allowWrite: [process.cwd()], denyWrite: [] },
    });
  });
});
