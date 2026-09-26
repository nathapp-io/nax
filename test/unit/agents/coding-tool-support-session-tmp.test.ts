/**
 * US-004 — the run id has to reach the launcher as a per-session temp dir.
 *
 * `resolveCodingToolSupport` is the seam both dispatch hops use, so it is the
 * only place the run id can be threaded into `resolveSessionSandbox` as
 * `tmpDir: sessionTmpDir(runId, sessionName)`. A test against
 * `resolveSessionSandbox` alone would stay green if this thread were dropped,
 * and every real Bash command would keep writing into the shared `/tmp`.
 *
 * Driven from `resolveCodingToolSupport` to `runtime.callTool("Bash", …)` with
 * `_launcherDeps.runArgv` stubbed, so no command is really executed (the
 * session directory itself is still created by the launcher, and removed in
 * afterEach).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir, withDepsRestore } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";
import { _launcherDeps, _resetSandboxRegistryForTests } from "@/sandbox";

/** `runTmpRoot("r1")` — the directory the launcher creates for run `r1`. */
const RUN_TMP_ROOT = "/tmp/nax-r1";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-cts-session-tmp-");
});
afterEach(() => {
  cleanupTempDir(root);
  cleanupTempDir(RUN_TMP_ROOT);
  _resetSandboxRegistryForTests(); // sandbox on by default: drop the cached backend
});

/** A granted Bash tool over a disabled sandbox — the production hop's config shape. */
const bashConfig = () => {
  const execution: Record<string, unknown> = {
    bashApproval: "raw",
    permissions: { run: { allow: ["Bash(echo *)"] } },
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

  test("US-004 AC12: a Bash call runs with TMPDIR at the run's session directory", async () => {
    const calls = recordingRunArgv();

    const support = await resolveCodingToolSupport({
      declaredTools: ["Bash"],
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
    // The ledger session name is `US-001-implementer`, so that is the directory
    // the run id must be scoped under.
    expect(calls[0]?.env?.TMPDIR).toBe("/tmp/nax-r1/US-001-implementer");
  });

  test("US-004 AC13: with no runId the Bash call runs with no TMPDIR", async () => {
    const calls = recordingRunArgv();

    const support = await resolveCodingToolSupport({
      declaredTools: ["Bash"],
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
    expect(calls[0]?.env?.TMPDIR).toBeUndefined();
  });
});
