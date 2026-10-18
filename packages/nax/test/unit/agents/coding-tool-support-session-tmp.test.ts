/**
 * US-004 — the run id has to reach the launcher as a per-session temp dir.
 *
 * `resolveCodingToolSupport` is the seam both dispatch hops use, so it is the
 * only place the run id can be threaded into `resolveSessionSandbox` as
 * `tmpDir: sessionTmpDirUnder(runTmpRoot(runId), sessionName)` — one parent
 * resolution feeding both the policy root and the TMPDIR. A test against
 * `resolveSessionSandbox` alone would stay green if this thread were dropped,
 * and every real Bash command would keep writing into the shared `/tmp`.
 *
 * Driven from `resolveCodingToolSupport` to `runtime.callTool("Bash", …)` with
 * the launcher's process and mkdir dependencies stubbed. This tests dispatch
 * wiring without requiring write access to the host's shared `/tmp/nax`.
 * The temp-root selector is pinned so the expected path is host-independent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _launcherDeps, _resetSandboxRegistryForTests, _sessionTmpDeps } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir, stubSessionTmpDeps, withDepsRestore } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-cts-session-tmp-");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests(); // sandbox on by default: drop the cached backend
});

/** A granted Bash tool over a disabled sandbox — the production hop's config shape. */
const bashConfig = () => {
  const execution: Record<string, unknown> = {
    bashApproval: "raw",
    permissions: { run: { allowedTools: ["Bash(echo *)"] } },
    sandbox: { enabled: false },
  };
  return makeNaxConfig({ execution });
};

function recordingRunArgv() {
  const calls: Parameters<typeof _launcherDeps.runArgv>[0][] = [];
  _launcherDeps.runArgv = async (o) => {
    calls.push(o);
    return { exitCode: 0, stdout: "hi\n", stderr: "", timedOut: false };
  };
  return calls;
}

describe("resolveCodingToolSupport — per-session TMPDIR (US-004)", () => {
  withDepsRestore(_launcherDeps);
  withDepsRestore(_sessionTmpDeps);

  const createdDirs: string[] = [];
  beforeEach(() => {
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });
    createdDirs.length = 0;
    _launcherDeps.mkdir = async (path) => {
      createdDirs.push(path);
    };
  });

  test("US-004 AC12: a Bash call runs with TMPDIR at the run's session directory", async () => {
    const calls = recordingRunArgv();

    const support = await resolveCodingToolSupport({
      declaredTools: ["Bash", "Write"],
      codingToolRoot: root,
      pipelineStage: "run",
      storyId: "US-001",
      sessionRole: "implementer",
      runId: "r1",
      config: bashConfig(),
    });
    expect(support).toBeDefined();

    const outcome = await support?.runtime.callTool("Bash", { command: "echo hi" });

    expect(outcome?.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    // The ledger session name is `US-001-implementer`, scoped under the run's
    // own root — `sessionTmpDirUnder("/tmp/nax/r1", "US-001-implementer")` under
    // the pinned layout, so a flat `/tmp/nax-r1` root fails here.
    expect(createdDirs).toEqual(["/tmp/nax/r1/US-001-implementer"]);
    expect(calls[0]?.env?.TMPDIR).toBe("/tmp/nax/r1/US-001-implementer");
  });

  test("US-004 AC13: with no runId the Bash call runs with no TMPDIR", async () => {
    const calls = recordingRunArgv();

    const support = await resolveCodingToolSupport({
      declaredTools: ["Bash", "Write"],
      codingToolRoot: root,
      pipelineStage: "run",
      storyId: "US-001",
      sessionRole: "implementer",
      config: bashConfig(),
    });
    expect(support).toBeDefined();

    const outcome = await support?.runtime.callTool("Bash", { command: "echo hi" });

    expect(outcome?.kind).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(createdDirs).toEqual([]);
    expect(calls[0]?.env?.TMPDIR).toBeUndefined();
  });
});
