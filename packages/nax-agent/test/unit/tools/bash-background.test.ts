import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ArgvExecResult, RunArgvOptions } from "#src/internal/argv-exec";
import { _bashToolDeps, createBashTool } from "#src/tools/bash";
import type { BackgroundCommandHandle, BackgroundCommandPort } from "#src/tools/bash-background";
import { assertDefined } from "#test/helpers/index";

const originalRun = _bashToolDeps.runArgv;
afterEach(() => {
  _bashToolDeps.runArgv = originalRun;
});

function fixture() {
  let handle: BackgroundCommandHandle | undefined;
  let options: RunArgvOptions | undefined;
  const append = mock((_stream: string, _chunk: Uint8Array) => {});
  const port: BackgroundCommandPort = {
    adopt(value) {
      handle = value;
      return { id: "bash-1a2b3c4d", append };
    },
    foreground: () => () => {},
  };
  const pending = Promise.withResolvers<ArgvExecResult>();
  _bashToolDeps.runArgv = (value) => {
    options = value;
    return pending.promise;
  };
  const controller = new AbortController();
  const ctx = {
    root: "/test",
    resolvedPaths: [],
    maxBytes: 40_000,
    maxFileBytes: 2_000_000,
    signal: controller.signal,
  };
  const opts = { background: port };
  const tool = createBashTool(opts);
  const result: { value?: Awaited<ReturnType<typeof tool.run>> } = {};
  async function start() {
    void tool.run({ command: "sleep 9", description: "wait", runInBackground: true }, ctx).then((value) => {
      result.value = value;
    });
    // Drain bounded microtasks, not a wall-clock sleep: the launch seam remains pending.
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  return {
    port,
    tool,
    start,
    result,
    append,
    controller,
    pending,
    handle: () => {
      assertDefined(handle);
      return handle;
    },
    options: () => {
      assertDefined(options);
      return options;
    },
  };
}

const sentence =
  'Set "runInBackground": true to return at once with a task id; a notice arrives when the command ends.';
const oldDescription =
  "Run one shell command string under /bin/sh. PREFER the structured tools when they express the task -- Read, Glob, Grep, Git and RunCommand return bounded, parseable output, and Bash exists for what they cannot express. no command forms are granted for this stage; anything else is refused. Each segment of a `&&`/`||`/`;`/`|` chain is checked separately, and command substitution ($(...), backticks), process substitution, here-documents and `2>&1` are refused outright because they cannot be analysed. Paths and redirect targets must stay inside the repository root. background processes still holding the command's output are killed when the command exits. ";

describe("createBashTool background", () => {
  test("background uses the sandbox launcher and rewrite but never postProcess", async () => {
    const f = fixture();
    const postProcess = mock(() => ({ output: "rewritten output" }));
    const launcherRun = mock(async (request: import("#src/sandbox/index").LaunchRequest) => {
      expect(request.spec).toEqual({ kind: "shell", shell: "/bin/sh", command: "rtk sleep 9" });
      expect(request.releaseDeadline?.aborted).toBe(true);
      request.onOutput?.("stdout", new TextEncoder().encode("raw"));
      return {
        exitCode: 0,
        timedOut: false,
        stdout: "raw",
        stderr: "",
        executed: ["/bin/sh", "-c", "rtk sleep 9"],
        sandbox: { backend: "none" as const, wrapped: false },
      };
    });
    const result = await createBashTool({
      background: f.port,
      launcher: { state: { kind: "disabled" }, run: launcherRun },
    }).run(
      { command: "sleep 9", runInBackground: true },
      {
        root: "/test",
        resolvedPaths: [],
        maxBytes: 40_000,
        maxFileBytes: 2_000_000,
        interceptor: {
          provider: "rtk",
          intercept: async () => ({ kind: "unchanged" }),
          interceptShell: async () => ({ kind: "rewritten", command: "rtk sleep 9", provider: "rtk" }),
          postProcess,
        },
      },
    );
    expect(result.isError).toBe(false);
    await f.handle().ended;
    expect(launcherRun).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith("stdout", new TextEncoder().encode("raw"));
    expect(postProcess).not.toHaveBeenCalled();
  });
  test.each([undefined, false, "true"])(
    "a port without exact true (%s) keeps foreground behavior",
    async (runInBackground) => {
      const f = fixture();
      f.pending.resolve({ exitCode: 0, timedOut: false, stdout: "foreground", stderr: "" });
      const result = await f.tool.run(
        { command: "sleep 9", runInBackground },
        { root: "/test", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 },
      );
      expect(result.content).toContain("exit 0\nforeground");
      // A port makes the foreground call movable, but its deadline stays active until moved.
      expect(f.options().releaseDeadline?.aborted).toBe(false);
    },
  );
  test("without a port even true keeps foreground behavior", async () => {
    const f = fixture();
    f.pending.resolve({ exitCode: 0, timedOut: false, stdout: "foreground", stderr: "" });
    const result = await createBashTool({}).run(
      { command: "sleep 9", runInBackground: true },
      { root: "/test", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 2_000_000 },
    );
    expect(result.content).toContain("foreground");
    expect(f.options().releaseDeadline).toBeUndefined();
  });
  test("AC-1 no background property by default", () => {
    expect(createBashTool({}).inputSchema.properties).not.toHaveProperty("runInBackground");
  });
  test("AC-2 preserves the pre-feature description byte for byte", () => {
    expect(createBashTool({}).description).toBe(oldDescription);
  });
  test("AC-3 advertises a boolean with a port", () => {
    expect(fixture().tool.inputSchema.properties).toHaveProperty("runInBackground", { type: "boolean" });
  });
  test("AC-4 appends the exact background sentence", () => {
    expect(fixture().tool.description).toBe(oldDescription + sentence);
  });
  test("AC-5 returns the id before the launch settles", async () => {
    const f = fixture();
    await f.start();
    expect(f.result.value?.content).toBe("started in the background as bash-1a2b3c4d");
  });
  test("AC-6 returns isError false", async () => {
    const f = fixture();
    await f.start();
    expect(f.result.value?.isError).toBe(false);
  });
  test("AC-7 releases the deadline before launch", async () => {
    const f = fixture();
    await f.start();
    expect(f.options().releaseDeadline?.aborted).toBe(true);
  });
  test("AC-8 owns a signal distinct from the context", async () => {
    const f = fixture();
    await f.start();
    expect(f.options().signal).toBeInstanceOf(AbortSignal);
    expect(f.options().signal).not.toBe(f.controller.signal);
  });
  test("AC-9 adopts with agent origin", async () => {
    const f = fixture();
    await f.start();
    expect(f.handle().origin).toBe("agent");
  });
  test("AC-10 adopts the original command and description", async () => {
    const f = fixture();
    await f.start();
    expect(f.handle().command).toBe("sleep 9");
    expect(f.handle().description).toBe("wait");
  });
  test("AC-11 turn cancellation leaves the launch running", async () => {
    const f = fixture();
    await f.start();
    f.controller.abort();
    expect(f.options().signal?.aborted).toBe(false);
  });
  test("AC-12 stop aborts the owned signal", async () => {
    const f = fixture();
    await f.start();
    f.handle().stop();
    expect(f.options().signal?.aborted).toBe(true);
    f.pending.resolve({ exitCode: -1, stdout: "", stderr: "", timedOut: false, aborted: true });
    expect((await f.handle().ended).aborted).toBe(true);
  });
  test.each(["stdout", "stderr"] as const)("AC-13 forwards every %s chunk unchanged", async (stream) => {
    const f = fixture();
    await f.start();
    const chunk = new TextEncoder().encode("x");
    f.options().onOutput?.(stream, chunk);
    f.options().onOutput?.(stream, chunk);
    expect(f.append).toHaveBeenCalledTimes(2);
    expect(f.append).toHaveBeenCalledWith(stream, chunk);
  });
  test("AC-14 ended resolves the launch exit code", async () => {
    const f = fixture();
    await f.start();
    f.pending.resolve({ exitCode: 3, timedOut: false, stdout: "", stderr: "" });
    expect(await f.handle().ended).toEqual({ exitCode: 3, timedOut: false, aborted: false });
  });
  test("AC-15 launch rejection resolves a failure end", async () => {
    const f = fixture();
    await f.start();
    f.pending.reject(new Error("wrap failed"));
    expect(await f.handle().ended).toEqual({
      exitCode: -1,
      timedOut: false,
      aborted: false,
      launchError: "wrap failed",
    });
  });
  test("AC-16 rejection is handled even before ended is consumed", async () => {
    const f = fixture();
    await f.start();
    const unhandled = mock(() => {});
    process.on("unhandledRejection", unhandled);
    try {
      f.pending.reject(new Error("wrap failed"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect((await f.handle().ended).launchError).toBe("wrap failed");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
