import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

describe("resolveSessionSandbox", () => {
  withDepsRestore(_sessionSandboxDeps);

  test("disabled config: disabled launcher, probe never runs", async () => {
    let probes = 0;
    _sessionSandboxDeps.probe = async () => {
      probes += 1;
      return { available: true };
    };
    const l = await resolveSessionSandbox({ config: DEFAULT_SANDBOX_CONFIG, root, needsLauncher: true });
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

  test("enabled + unavailable: unavailable launcher and a raw refusal", async () => {
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no bwrap" });
    const l = await resolveSessionSandbox({ config: enabled, root, needsLauncher: true });
    expect(l.state).toEqual({ kind: "unavailable", backend: "srt", reason: "no bwrap" });
    expect(rawRefusalFor(l)).toContain("sandbox unavailable (no bwrap)");
  });

  test("rawRefusalFor is undefined unless unavailable", () => {
    expect(rawRefusalFor(undefined)).toBeUndefined();
  });
});
