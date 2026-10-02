import { afterEach, describe, expect, test } from "bun:test";
import { _argvExecDeps } from "#src/internal/argv-exec";
import { _gitDeps } from "#src/internal/git-exec";
import { _execSourceDeps } from "#src/native/credentials/helper-process";
import { type AgentRuntime, setAgentRuntime } from "#src/runtime/index";
import { _grepDeps } from "#src/tools/grep";

/** A runtime installed AFTER the seams' modules loaded: a seam that captured the runtime at load would miss it. */
function recordingRuntime(): AgentRuntime & { calls: { cmd: readonly string[]; stdin?: string }[] } {
  const calls: { cmd: readonly string[]; stdin?: string }[] = [];
  return {
    calls,
    spawn(cmd, opts) {
      calls.push({ cmd, stdin: opts.stdin });
      throw new Error("recorded");
    },
  };
}

describe("nax-agent's spawn seams resolve the runtime slot per call", () => {
  afterEach(() => setAgentRuntime(null));

  test.each([
    ["_gitDeps", () => _gitDeps.spawn(["git", "status"], { stdout: "pipe", stderr: "pipe" })],
    ["_argvExecDeps", () => _argvExecDeps.spawn(["echo", "x"], { stdout: "pipe", stderr: "pipe" })],
    ["_grepDeps", () => _grepDeps.spawn(["rg", "x"], { stdout: "pipe", stderr: "pipe" })],
  ] as const)("%s.spawn goes through the installed runtime", (_name, call) => {
    const rt = recordingRuntime();
    setAgentRuntime(rt);
    expect(call).toThrow("recorded");
    expect(rt.calls).toHaveLength(1);
  });

  test("_execSourceDeps.spawn goes through the installed runtime with stdin piped", () => {
    const rt = recordingRuntime();
    setAgentRuntime(rt);
    expect(() => _execSourceDeps.spawn(["helper"])).toThrow("recorded");
    expect(rt.calls).toEqual([{ cmd: ["helper"], stdin: "pipe" }]);
  });
});
