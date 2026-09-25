import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "@test/helpers";
import { _sessionSandboxDeps, rawRefusalFor, resolveSessionSandbox } from "@/agents/coding-tool-sandbox";
import { DEFAULT_SANDBOX_CONFIG } from "@/config/schemas-sandbox";
import { _resetSandboxRegistryForTests } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

let root: string;
beforeEach(() => {
  root = makeTempDir("session-sbx-");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests();
});

const enabled = { ...DEFAULT_SANDBOX_CONFIG, enabled: true };
const disabled = { ...DEFAULT_SANDBOX_CONFIG, enabled: false };

describe("resolveSessionSandbox", () => {
  withDepsRestore(_sessionSandboxDeps);

  test("disabled config: disabled launcher, probe never runs", async () => {
    let probes = 0;
    _sessionSandboxDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const l = await resolveSessionSandbox({ config: disabled, root, needsLauncher: true });
    expect(l.state).toEqual({ kind: "disabled" });
    expect(probes).toBe(0);
  });

  test("enabled but no Bash/Exec declared: disabled launcher, probe never runs", async () => {
    let probes = 0;
    _sessionSandboxDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const l = await resolveSessionSandbox({ config: enabled, root, needsLauncher: false });
    expect(l.state.kind).toBe("disabled");
    expect(probes).toBe(0);
  });

  test("enabled + available: policy carries the approvals file and the story root", async () => {
    const backend = makeFakeSandboxBackend();
    _sessionSandboxDeps.backendFor = () => backend;
    _sessionSandboxDeps.probe = async () => ({ available: true });
    const outputDir = `${root}/out`;
    const l = await resolveSessionSandbox({ config: enabled, root, outputDir, needsLauncher: true });
    expect(l.state).toEqual({ kind: "available", backend: "srt", network: "open" });
    await l.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    });
    const policy = backend.calls[0]?.policy;
    expect(policy?.denyWrite.some((p) => p.endsWith("/out/approvals.json"))).toBe(true);
    expect(policy?.writeRoots).toContain(realOrRaw(root));
  });

  test("#2198: every policy carries the git guard files, and the commondir tripwire runs after each command", async () => {
    const backend = makeFakeSandboxBackend();
    _sessionSandboxDeps.backendFor = () => backend;
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${root}/.git` });
    const sibling = `${root}/.git/worktrees/US-002/commondir`;
    _sessionSandboxDeps.gitGuardFiles = async () => [sibling];
    let tripped = 0;
    _sessionSandboxDeps.commonDirTripwire = async () => async () => {
      tripped += 1;
    };
    const l = await resolveSessionSandbox({ config: enabled, root, needsLauncher: true });
    const req = {
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    } as const;
    await l.run(req);
    await l.run(req);
    expect(backend.calls[0]?.policy.denyWrite).toContain(realOrRaw(sibling));
    expect(tripped).toBe(2);
  });

  test("enabled + unavailable: unavailable launcher and a raw refusal", async () => {
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no bwrap" });
    const l = await resolveSessionSandbox({ config: enabled, root, needsLauncher: true });
    expect(l.state).toEqual({ kind: "unavailable", backend: "srt", reason: "no bwrap" });
    expect(rawRefusalFor(l)).toContain("sandbox unavailable (no bwrap)");
  });

  test("#17: a glob character in the root makes the sandbox unavailable at session start", async () => {
    const globRoot = join(root, "re[x]po");
    mkdirSync(globRoot);
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${globRoot}/.git` });
    _sessionSandboxDeps.gitGuardFiles = async () => [];
    const l = await resolveSessionSandbox({ config: enabled, root: globRoot, needsLauncher: true });
    expect(l.state.kind).toBe("unavailable");
    expect(l.state.kind === "unavailable" ? l.state.reason : "").toContain("re[x]po");
    expect(rawRefusalFor(l)).toBeDefined();
  });

  test("#17: a policy error that is not a glob still propagates", async () => {
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${root}/.git` });
    _sessionSandboxDeps.featurePrds = async () => {
      throw new Error("boom");
    };
    await expect(resolveSessionSandbox({ config: enabled, root, needsLauncher: true })).rejects.toThrow("boom");
  });

  test("rawRefusalFor is undefined unless unavailable", () => {
    expect(rawRefusalFor(undefined)).toBeUndefined();
  });
});
