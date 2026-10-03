import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { _argvExecDeps } from "#src/internal/argv-exec";
import { _gitDeps } from "#src/internal/git-exec";
import { _execSourceDeps } from "#src/native/credentials/helper-process";
import { type AgentRuntime, nodeRuntime, setAgentRuntime } from "#src/runtime/index";
import { globTool } from "#src/tools/glob";
import { _grepDeps } from "#src/tools/grep";
import { SCRATCHPAD_DIR, scratchpadListTool } from "#src/tools/scratchpad";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

/** A runtime installed AFTER the seams' modules loaded: a seam that captured the runtime at load would miss it. */
function recordingRuntime(): AgentRuntime & { calls: { cmd: readonly string[]; stdin?: string }[] } {
  const calls: { cmd: readonly string[]; stdin?: string }[] = [];
  return {
    ...nodeRuntime,
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

  test("_execSourceDeps.spawn refuses a runtime that gave a piped spawn no stdin (CREDENTIAL_HELPER_FAILED)", () => {
    const noStdin: AgentRuntime = {
      ...nodeRuntime,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exited: Promise.resolve(0),
        pid: 1,
        exitCode: 0,
        signalCode: null,
        kill: () => {},
      }),
    };
    setAgentRuntime(noStdin);
    expect(() => _execSourceDeps.spawn(["helper"])).toThrow(
      expect.objectContaining({ code: "CREDENTIAL_HELPER_FAILED" }),
    );
  });
});

describe("glob tools resolve the runtime slot after module load", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("glob-delegation-");
  });
  afterEach(() => {
    setAgentRuntime(null);
    cleanupTempDir(root);
  });

  test("Glob delegates to the installed asynchronous scanner and groups its results", async () => {
    const calls: { pattern: string; opts: { cwd: string; absolute: boolean } }[] = [];
    setAgentRuntime({
      ...nodeRuntime,
      async *glob(pattern, opts) {
        calls.push({ pattern, opts });
        yield "b.ts";
        yield "a.ts";
      },
    });
    const result = await globTool.run(
      { pattern: "*.ts" },
      { root, resolvedPaths: [], maxBytes: 10000, maxFileBytes: 10000 },
    );
    expect(result.content).toBe("./ a.ts b.ts");
    expect(calls).toEqual([{ pattern: "*.ts", opts: { cwd: root, absolute: false } }]);
  });

  test("ScratchpadList delegates to the installed synchronous scanner and sorts its results", async () => {
    mkdirSync(join(root, SCRATCHPAD_DIR), { recursive: true });
    const calls: { pattern: string; opts: { cwd: string; absolute: boolean } }[] = [];
    setAgentRuntime({
      ...nodeRuntime,
      *globSync(pattern, opts) {
        calls.push({ pattern, opts });
        yield "b.txt";
        yield "a.txt";
      },
    });
    const result = await scratchpadListTool.run({}, { root, resolvedPaths: [], maxBytes: 10000, maxFileBytes: 10000 });
    expect(result.content).toBe("a.txt\nb.txt");
    expect(calls).toEqual([{ pattern: "**/*", opts: { cwd: join(root, SCRATCHPAD_DIR), absolute: false } }]);
  });
});
