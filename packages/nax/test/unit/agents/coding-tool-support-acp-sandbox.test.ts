/**
 * nax#2500 — the dispatch sandbox rides the resolved support as `acpSandbox`,
 * so an ACP open can hand it to a backend that runs its own shell.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CodingToolName } from "@nathapp/nax-agent";
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

const REVIEWER_TOOLS = ["Read", "Glob", "Grep", "Git", "Bash"] as const;

const resolveWith = (sandbox: Record<string, unknown>, declaredTools: readonly CodingToolName[] = ["Read", "Bash"]) =>
  resolveCodingToolSupport({
    declaredTools,
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

  describe("reviewer commands need a usable sandbox (R9)", () => {
    const toolNames = (support: Awaited<ReturnType<typeof resolveWith>>) =>
      (support?.tools ?? []).map((t: { name: string }) => t.name);

    test("a disabled sandbox withholds Bash from a reviewer declaration", async () => {
      const support = await resolveWith({ enabled: false }, REVIEWER_TOOLS);
      expect(support?.declaredTools).not.toContain("Bash");
      expect(support?.acpSandbox).toBeUndefined();
      expect(toolNames(support)).not.toContain("Bash");
    });

    test("an unavailable sandbox withholds Bash from a reviewer declaration", async () => {
      _sandboxRegistryDeps.createBackend = () => fakeBackend;
      _sandboxRegistryDeps.probe = async () => ({ available: false, reason: "no bwrap" });
      const support = await resolveWith({ enabled: true }, REVIEWER_TOOLS);
      expect(support?.declaredTools).not.toContain("Bash");
      expect(support?.acpSandbox).toBeUndefined();
      expect(toolNames(support)).not.toContain("Bash");
    });

    test("an available sandbox keeps Bash and attaches a policy", async () => {
      _sandboxRegistryDeps.createBackend = () => fakeBackend;
      _sandboxRegistryDeps.probe = async () => ({ available: true });
      const support = await resolveWith({ enabled: true }, REVIEWER_TOOLS);
      expect(support?.declaredTools).toContain("Bash");
      expect(support?.acpSandbox?.kind).toBe("policy");
    });

    test("an implementer declaration keeps Bash when the sandbox is disabled", async () => {
      const support = await resolveWith({ enabled: false }, ["Read", "Write", "Edit", "Bash"]);
      expect(support?.declaredTools).toContain("Bash");
      expect(toolNames(support)).toContain("Bash");
    });
  });
});
