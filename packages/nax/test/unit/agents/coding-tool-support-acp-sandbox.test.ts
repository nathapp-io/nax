/**
 * nax#2500 — the dispatch sandbox rides the resolved support as `acpSandbox`,
 * so an ACP open can hand it to a backend that runs its own shell.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetSandboxRegistryForTests, _sandboxRegistryDeps, type SandboxBackend } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-cts-acp-sandbox-");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests();
});

const fakeBackend: SandboxBackend = {
  name: "srt",
  isSupportedPlatform: async () => true,
  wrap: async () => ["true"],
  annotate: () => "",
  commandFinished: () => {},
  reset: async () => {},
};

const resolveWith = (sandbox: Record<string, unknown>) =>
  resolveCodingToolSupport({
    declaredTools: ["Read", "Bash"],
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({
      execution: { bashApproval: "raw", sandbox },
    }),
  });

describe("resolveCodingToolSupport — acpSandbox (nax#2500)", () => {
  withDepsRestore(_sandboxRegistryDeps);

  test("an available launcher yields a policy sandbox", async () => {
    _sandboxRegistryDeps.createBackend = () => fakeBackend;
    _sandboxRegistryDeps.probe = async () => ({ available: true });
    const support = await resolveWith({ enabled: true });
    expect(support?.acpSandbox?.kind).toBe("policy");
  });

  test("a disabled sandbox leaves acpSandbox absent", async () => {
    const support = await resolveWith({ enabled: false });
    expect(support).toBeDefined();
    expect(support?.acpSandbox).toBeUndefined();
  });
});
