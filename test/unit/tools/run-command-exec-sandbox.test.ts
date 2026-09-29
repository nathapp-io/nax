import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "@test/helpers";
import { _launcherDeps, createCommandLauncher } from "@/sandbox";
import { createRunCommandTool } from "@/tools";
import { runExecBranch } from "@/tools/run-command-exec";
import { _agentOutputEnvDeps } from "@/utils/agent-output-env";

let root: string;
beforeEach(() => {
  root = makeTempDir("exec-sbx-");
  mkdirSync(join(root, "packages", "app"), { recursive: true });
});
afterEach(() => cleanupTempDir(root));

const ctx = () => ({ root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 });
const policyFor = async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} });

describe("Exec through the launcher", () => {
  test("Review Focus 5: package target runs in the package dir, roots derive from ctx.root, audit carries the record", async () => {
    const backend = makeFakeSandboxBackend();
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor: async (r) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    const result = await runExecBranch({ argv: ["bun", "--version"], target: "package" }, ctx(), {
      exec: {
        repoRoot: root,
        packageWorkdir: join(root, "packages", "app"),
        allowScripts: false,
        patterns: ["bun *"],
        launcher,
      },
    });
    expect(backend.calls[0]?.cwd).toBe(join(root, "packages", "app"));
    expect(result.audit?.cwd).toBe(join(root, "packages", "app"));
    expect(backend.calls[0]?.policy.writeRoots).toEqual([root]);
    expect(result.audit?.sandbox).toEqual({
      backend: "srt",
      wrapped: true,
      argv: ["/bin/sh", "-c", "'bun' '--version'"],
    });
  });
});

// US-003: the Exec branch's description carries the sandbox sentence. Under a
// confined session the writable temp root is this run's own directory, so the
// description must stop promising "the system temp directories".
describe("US-003 — RunCommand description names the confined temp root", () => {
  const execTool = (state: "confined" | "shared") =>
    createRunCommandTool(new Map([["test", "bun test"]]), {
      exec: {
        repoRoot: root,
        packageWorkdir: root,
        allowScripts: false,
        patterns: ["bun *"],
        launcher: createCommandLauncher({
          state:
            state === "confined"
              ? { kind: "available", backend: "srt", network: "open", sharedTmp: false }
              : { kind: "available", backend: "srt", network: "open" },
          backend: makeFakeSandboxBackend(),
          policyFor,
        }),
      },
    });

  test("US-003 AC6: sharedTmp:false names this run's temp directory", () => {
    const description = execTool("confined").description;
    expect(description).toContain("this run's temp directory ($TMPDIR)");
    expect(description).not.toContain("the system temp directories");
  });

  test("US-003 AC6 boundary: a shared-temp launcher keeps the pre-change wording", () => {
    const description = execTool("shared").description;
    expect(description).toContain("the system temp directories");
    expect(description).not.toContain("this run's temp directory ($TMPDIR)");
  });
});

describe("Exec env overlay through the launcher", () => {
  withDepsRestore(_launcherDeps);
  withDepsRestore(_agentOutputEnvDeps, ["processEnv"]);

  // US-004 replaced this test's invariant: the launcher's env is no longer
  // exactly the Yarn key. Marker presence is read from the nax process
  // environment, so the overlay is stubbed marker-free here — otherwise the
  // assertion would flip depending on whether the suite was launched from an
  // agent shell. What must hold now: the Yarn no-scripts key survives wrapping
  // alongside the agent-output key.
  test("US-004 AC11: the Yarn no-scripts env overlay survives wrapping alongside AGENT=1", async () => {
    _agentOutputEnvDeps.processEnv = () => ({ PATH: "/usr/bin" });
    const seen: { env?: Readonly<Record<string, string>> }[] = [];
    _launcherDeps.runArgv = async (o) => {
      seen.push(o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend: makeFakeSandboxBackend(),
      policyFor: async (r) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    await runExecBranch({ argv: ["yarn", "add", "left-pad"], target: "repoRoot" }, ctx(), {
      exec: { repoRoot: root, packageWorkdir: root, allowScripts: false, patterns: ["yarn *"], launcher },
    });
    expect(seen[0]?.env).toEqual({ YARN_ENABLE_SCRIPTS: "false", AGENT: "1" });
  });
});
