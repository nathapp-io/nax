/**
 * Runs inside the temporary consumer that installed the packed nax-agent
 * tarball (S2 spec §7.3). Plain Node ESM: no repo imports, no test framework.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCredentials, globTool, NativeSessionAdapter, resetSandboxBackend } from "@nathapp/nax-agent";
import { _clientDeps, DEFAULT_SANDBOX_CONFIG, resolveSessionSandbox } from "@nathapp/nax-agent/internal";

assert.equal(process.versions.bun, undefined, "the packed smoke must run on native Node");

const workdir = mkdtempSync(join(tmpdir(), "nax-packed-"));
writeFileSync(join(workdir, "hello.txt"), "hello");

// The credentials slot throws when unset (S1 D12); an embedder fills it the
// way nax's CLI does. The session turn below reads it before the stub client.
const configDir = join(workdir, "global-config");
mkdirSync(configDir, { recursive: true });
configureCredentials({
  configDir: () => configDir,
  readAuthConfig: async () => ({ source: "file", onChange: "warn" }),
});

// 1. One tool round-trip through the packed entry.
const globbed = await globTool.run(
  { pattern: "*.txt" },
  { root: workdir, resolvedPaths: [], maxBytes: 10_000, maxFileBytes: 10_000 },
);
assert.match(globbed.content, /hello\.txt/, `glob tool missed the file: ${globbed.content}`);

// 2. One native session turn against a stub client (the /internal seam the
//    package's own tests use; /internal ships in the tarball).
const model = {
  id: "packed-stub",
  provider: "stub",
  protocol: "stub",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};
_clientDeps.build = async () => ({
  model: async () => model,
  listModels: async () => [model],
  pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
  stream: async function* () {},
  complete: async () => ({ text: "packed-ok", usage: { inputTokens: 2, outputTokens: 3 }, stopReason: "stop" }),
  validate: () => {},
});
const transcriptDir = join(workdir, "transcripts");
mkdirSync(transcriptDir, { recursive: true });
const adapter = new NativeSessionAdapter();
const handle = await adapter.openSession("packed-smoke", {
  agentName: "native",
  workdir,
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "stub", model: "stub/packed-stub" },
  timeoutSeconds: 60,
  transcriptDir,
});
const turn = await adapter.sendTurn(handle, "hi", {
  interactionHandler: { onInteraction: async () => ({ answer: "" }) },
});
assert.equal(turn.output, "packed-ok", `unexpected turn output: ${turn.output}`);
await adapter.closeSession(handle);

// 3. Linux only (spec §7.3): one command through the real OS sandbox. A
//    missing sandbox FAILS here; CI installs bubblewrap.
if (process.platform === "linux") {
  try {
    const launcher = await resolveSessionSandbox({
      config: DEFAULT_SANDBOX_CONFIG,
      root: workdir,
      needsLauncher: true,
      protectedPaths: {
        gitExcludePathspecs: [],
        gitIgnorePatterns: [],
        projectStateDir: ".nax",
        credentialDir: join(workdir, ".credentials"),
        trustStoreFile: join(workdir, ".trust.json"),
      },
    });
    const result = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: "echo packed-sandbox" },
      root: workdir,
      cwd: workdir,
      timeoutMs: 30_000,
      stripEnvVars: [],
    });
    assert.equal(result.sandbox.wrapped, true, `sandbox was not applied: ${JSON.stringify(result.sandbox)}`);
    assert.equal(result.exitCode, 0, `sandboxed command failed: ${result.stderr}`);
    assert.match(result.stdout, /packed-sandbox/);
  } finally {
    // Linux's socat bridge keeps Node alive until the backend is reset.
    await resetSandboxBackend();
  }
}

console.log("packed smoke ok");
