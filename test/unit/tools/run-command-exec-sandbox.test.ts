import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeSandboxBackend, makeTempDir, withDepsRestore } from "@test/helpers";
import { _launcherDeps, createCommandLauncher } from "@/sandbox";
import { runExecBranch } from "@/tools/run-command-exec";

let root: string;
beforeEach(() => {
  root = makeTempDir("exec-sbx-");
  mkdirSync(join(root, "packages", "app"), { recursive: true });
});
afterEach(() => cleanupTempDir(root));

const ctx = () => ({ root, resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 });

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
    expect(backend.calls[0]?.policy.writeRoots).toEqual([root]);
    expect(result.audit?.sandbox).toEqual({ backend: "srt", wrapped: true });
  });
});

describe("Exec env overlay through the launcher", () => {
  withDepsRestore(_launcherDeps);

  test("Review Focus 5: the Yarn no-scripts env overlay survives wrapping", async () => {
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
    expect(seen[0]?.env).toEqual({ YARN_ENABLE_SCRIPTS: "false" });
  });
});
