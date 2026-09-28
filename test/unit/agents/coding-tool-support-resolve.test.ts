/**
 * US-002 — the run's own temp root has to reach the sandbox policy through the
 * dispatcher, not just the session dir.
 *
 * `resolveDispatchLauncher` is the single place a run id enters the sandbox
 * decision for a dispatched session, so it is the only place
 * `runTmpRoot(options.runId)` can be threaded into `resolveSessionSandbox`. A
 * test against `resolveSessionSandbox` alone stays green if that thread is
 * dropped, and every Bash/Exec command an agent runs would keep the shared
 * `/tmp` write root.
 *
 * Driven through the real dispatch seam with `_launcherDeps.runArgv` stubbed, so
 * no command is executed and nothing is created under the real `/tmp`: the
 * seam's `mkdir` is stubbed too. `/tmp/nax` is pinned absent through
 * `_sessionTmpDeps`, so `runTmpRoot("r1")` is `/tmp/nax/r1` on any host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  type ConfinedSessionSeam,
  cleanupTempDir,
  makeNaxConfig,
  makeTempDir,
  stubSessionSandboxDeps,
  stubSessionTmpDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "@test/helpers";
import { _sessionSandboxDeps } from "@/agents/coding-tool-sandbox";
import { resolveDispatchLauncher } from "@/agents/coding-tool-support-resolve";
import {
  _launcherDeps,
  _resetSandboxRegistryForTests,
  _sessionTmpDeps,
  type LaunchRequest,
  runTmpRoot,
  type SandboxPolicy,
} from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

const RUN_ID = "r1";
/** The ledger session name the dispatch derives for a story + role. */
const SESSION_NAME = "US-002-implementer";
/** Bash is what makes `resolveDispatchLauncher` ask for a launcher at all. */
const DECLARED = ["Bash"] as const;

describe("resolveDispatchLauncher — US-002 the run's own temp root", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  withDepsRestore(_sessionTmpDeps);
  withDepsRestore(_launcherDeps);

  let root: string;
  beforeEach(() => {
    root = makeTempDir("dispatch-run-tmp-");
    // US-001: `/tmp/nax` absent, so the run root of "r1" is `/tmp/nax/r1`.
    stubSessionTmpDeps(_sessionTmpDeps, { parent: "ENOENT" });
    _launcherDeps.runArgv = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    _launcherDeps.mkdir = async () => undefined;
  });
  afterEach(() => {
    cleanupTempDir(root);
    _resetSandboxRegistryForTests();
  });

  function dispatchOptions() {
    return {
      codingToolRoot: root,
      runId: RUN_ID,
      config: makeNaxConfig({ execution: { sandbox: { enabled: true } } }),
    };
  }

  function launchRequest(): LaunchRequest {
    return {
      spec: { kind: "shell", shell: "/bin/sh", command: "true" },
      root,
      cwd: root,
      timeoutMs: 5000,
      stripEnvVars: [],
    };
  }

  /** Resolve the dispatch launcher and run one shell command through it. */
  async function runDispatched(): Promise<{ seam: ConfinedSessionSeam; policy: SandboxPolicy }> {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const launcher = await resolveDispatchLauncher(dispatchOptions(), DECLARED, SESSION_NAME);
    assertDefined(launcher, "the dispatch launcher");
    await launcher.run(launchRequest());
    const call = seam.backend.calls[0];
    assertDefined(call, "the request backend.wrap received");
    return { seam, policy: call.policy };
  }

  test("US-002 AC11: a dispatched command's policy grants the run's own temp root", async () => {
    const { policy } = await runDispatched();

    expect(policy.writeRoots).toContain(realOrRaw(runTmpRoot(RUN_ID)));
  });

  test("US-002 AC12: a dispatched command's policy drops the shared /tmp root", async () => {
    const { policy } = await runDispatched();

    expect(policy.writeRoots).not.toContain(realOrRaw("/tmp"));
  });
});
