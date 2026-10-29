import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ArgvExecResult, RunArgvOptions } from "#src/internal/argv-exec";
import { _bashToolDeps, createBashTool } from "#src/tools/bash";
import type { BackgroundCommandHandle, BackgroundCommandPort, ForegroundCommand } from "#src/tools/bash-background";
import { assertDefined } from "#test/helpers/index";

const originalRun = _bashToolDeps.runArgv;
afterEach(() => {
  _bashToolDeps.runArgv = originalRun;
});
const success = { exitCode: 0, stdout: "x", stderr: "", timedOut: false };
// Contract cap, independently pinned so increasing the implementation cap fails the tests.
const replayBytes = 1024 * 1024;
async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fixture(withPort = true) {
  let call: ForegroundCommand | undefined;
  let handle: BackgroundCommandHandle | undefined;
  let options: RunArgvOptions | undefined;
  const pending = Promise.withResolvers<ArgvExecResult>();
  const unregister = mock(() => {});
  const append = mock((_stream: string, _chunk: Uint8Array) => {});
  const adopt = mock((value: BackgroundCommandHandle) => {
    handle = value;
    return { id: "bash-1a2b3c4d", append };
  });
  const foreground = mock((value: ForegroundCommand) => {
    call = value;
    return unregister;
  });
  const port: BackgroundCommandPort = { adopt, foreground };
  _bashToolDeps.runArgv = (value) => {
    options = value;
    return pending.promise;
  };
  const controller = new AbortController();
  const tool = createBashTool(withPort ? { background: port } : {});
  const result: { value?: Awaited<ReturnType<typeof tool.run>> } = {};
  const ctx = {
    root: "/test",
    resolvedPaths: [],
    maxBytes: 40_000,
    maxFileBytes: 2_000_000,
    signal: controller.signal,
  };
  return {
    pending,
    controller,
    foreground,
    unregister,
    adopt,
    append,
    result,
    async start(interceptor?: import("#src/tools/registry").ToolRunContext["interceptor"]) {
      void tool.run({ command: "bun test", description: "tests" }, { ...ctx, interceptor }).then((value) => {
        result.value = value;
      });
      await drain();
    },
    call() {
      assertDefined(call);
      return call;
    },
    handle() {
      assertDefined(handle);
      return handle;
    },
    options() {
      assertDefined(options);
      return options;
    },
    emit(stream: "stdout" | "stderr", text: string) {
      const output = options?.onOutput;
      assertDefined(output);
      output(stream, new TextEncoder().encode(text));
    },
  };
}

describe("createBashTool foreground move", () => {
  test("AC-1 registers the original foreground command once", async () => {
    const f = fixture();
    await f.start();
    expect(f.foreground).toHaveBeenCalledTimes(1);
    expect(f.call().command).toBe("bun test");
  });
  test("AC-2 unregisters exactly once on completion", async () => {
    const f = fixture();
    await f.start();
    f.pending.resolve(success);
    await drain();
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });
  test("AC-3 releases the pending tool result, while the callback returns void", async () => {
    const f = fixture();
    await f.start();
    expect(f.result.value).toBeUndefined();
    expect(f.call().moveToBackground()).toBeUndefined();
    await drain();
    expect(f.result.value?.content).toBe("moved to the background as bash-1a2b3c4d");
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });
  test("AC-4 moved tool results are successful", async () => {
    const f = fixture();
    await f.start();
    f.call().moveToBackground();
    await drain();
    expect(f.result.value?.isError).toBe(false);
  });
  test("AC-5 moving aborts the previously active deadline release signal", async () => {
    const f = fixture();
    await f.start();
    expect(f.options().releaseDeadline?.aborted).toBe(false);
    f.call().moveToBackground();
    expect(f.options().releaseDeadline?.aborted).toBe(true);
  });
  test("AC-6 adopts once with moved origin and retains metadata", async () => {
    const f = fixture();
    await f.start();
    f.call().moveToBackground();
    f.call().moveToBackground();
    expect(f.adopt).toHaveBeenCalledTimes(1);
    expect(f.handle().origin).toBe("moved");
    expect(f.handle().command).toBe("bun test");
    expect(f.handle().description).toBe("tests");
  });
  test("AC-7 replays both streams in order before forwarding live chunks", async () => {
    const f = fixture();
    await f.start();
    f.emit("stdout", "one");
    f.emit("stderr", "two");
    expect(f.append).not.toHaveBeenCalled();
    f.call().moveToBackground();
    f.emit("stdout", "three");
    expect(f.append.mock.calls.map(([stream, bytes]) => [stream, new TextDecoder().decode(bytes)])).toEqual([
      ["stdout", "one"],
      ["stderr", "two"],
      ["stdout", "three"],
    ]);
  });
  test("AC-8 retains at most one MiB even for an oversized single chunk", async () => {
    const f = fixture();
    await f.start();
    f.emit("stdout", "a".repeat(replayBytes + 10));
    f.call().moveToBackground();
    expect(f.append.mock.calls.reduce((n, [, bytes]) => n + bytes.byteLength, 0)).toBe(replayBytes);
  });
  test("AC-9 discards oldest bytes across chunks and preserves the last byte", async () => {
    const f = fixture();
    await f.start();
    f.emit("stdout", "old");
    f.emit("stderr", "a".repeat(replayBytes - 1));
    f.emit("stdout", "Z");
    f.call().moveToBackground();
    const replay = Buffer.concat(f.append.mock.calls.map(([, bytes]) => Buffer.from(bytes)));
    expect(replay.byteLength).toBe(replayBytes);
    expect(replay[0]).toBe(97);
    expect(replay[replay.length - 1]).toBe(90);
  });
  test("live output emitted during replay follows every retained chunk", async () => {
    const f = fixture();
    await f.start();
    f.emit("stdout", "A");
    f.emit("stderr", "b".repeat(replayBytes - 1));
    f.append.mockImplementationOnce(() => {
      f.emit("stdout", "C");
    });
    f.call().moveToBackground();
    expect(f.append.mock.calls.map(([stream, bytes]) => [stream, bytes.length, bytes[0]])).toEqual([
      ["stdout", 1, 65],
      ["stderr", replayBytes - 1, 98],
      ["stdout", 1, 67],
    ]);
  });
  test("replay copies bytes and trims a partially retained oldest chunk", async () => {
    const f = fixture();
    await f.start();
    const bytes = Buffer.from("a".repeat(20));
    f.options().onOutput?.("stdout", bytes);
    bytes.fill(90);
    f.emit("stderr", "b".repeat(replayBytes - 10));
    f.call().moveToBackground();
    expect(f.append.mock.calls[0]?.[1]).toEqual(new TextEncoder().encode("a".repeat(10)));
  });
  test("AC-10 turn cancellation after moving leaves the owned signal alive", async () => {
    const f = fixture();
    await f.start();
    f.call().moveToBackground();
    f.controller.abort();
    expect(f.options().signal?.aborted).toBe(false);
  });
  test("AC-11 turn cancellation before moving aborts the launch signal", async () => {
    const f = fixture();
    await f.start();
    const signal = f.options().signal;
    assertDefined(signal);
    expect(signal).not.toBe(f.controller.signal);
    const aborted = mock(() => {});
    signal.addEventListener("abort", aborted);
    f.controller.abort();
    expect(signal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
  });
  test("AC-12 a saved callback cannot adopt after foreground completion", async () => {
    const f = fixture();
    await f.start();
    const call = f.call();
    f.pending.resolve(success);
    await drain();
    call.moveToBackground();
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });
  test("AC-13 no port forwards the original context signal unchanged", async () => {
    const f = fixture(false);
    await f.start();
    expect(f.options().signal).toBe(f.controller.signal);
    expect(f.options().releaseDeadline).toBeUndefined();
    f.pending.resolve(success);
    await drain();
    expect(f.result.value?.content).toBe("exit 0\nx\n");
  });
  test("AC-14 an unmoved foreground call preserves exec framing", async () => {
    const f = fixture();
    await f.start();
    f.pending.resolve(success);
    await drain();
    expect(f.result.value?.content).toBe("exit 0\nx\n");
  });
  test("moved handles can stop the process and observe its completion", async () => {
    const f = fixture();
    await f.start();
    f.call().moveToBackground();
    f.handle().stop();
    expect(f.options().signal?.aborted).toBe(true);
    f.pending.resolve({ ...success, aborted: true });
    expect(await f.handle().ended).toEqual({ exitCode: 0, timedOut: false, aborted: true });
    expect(f.unregister).toHaveBeenCalledTimes(1);
  });
  test("moved launch failures resolve ended without rejecting", async () => {
    const f = fixture();
    await f.start();
    f.call().moveToBackground();
    f.pending.reject(new Error("launch failed"));
    expect(await f.handle().ended).toEqual({
      exitCode: -1,
      timedOut: false,
      aborted: false,
      launchError: "launch failed",
    });
  });
  test("foreground rejection unregisters and makes a saved callback inert", async () => {
    const f = fixture();
    await f.start();
    const call = f.call();
    f.pending.reject(new Error("launch failed"));
    await drain();
    call.moveToBackground();
    expect(f.result.value).toEqual({ content: "launch failed", isError: true });
    expect(f.unregister).toHaveBeenCalledTimes(1);
    expect(f.adopt).not.toHaveBeenCalled();
  });
  test("unmoved rewritten output still uses postProcess", async () => {
    const f = fixture();
    const postProcess = mock(() => ({ output: "processed" }));
    await f.start({
      provider: "rtk",
      intercept: async () => ({ kind: "unchanged" }),
      interceptShell: async () => ({ kind: "rewritten", command: "rtk bun test", provider: "rtk" }),
      postProcess,
    });
    f.pending.resolve(success);
    await drain();
    expect(f.result.value?.content).toBe("exit 0\nprocessed\n");
    expect(postProcess).toHaveBeenCalledTimes(1);
  });
  test("moved rewritten output bypasses postProcess", async () => {
    const f = fixture();
    const postProcess = mock(() => ({ output: "processed" }));
    await f.start({
      provider: "rtk",
      intercept: async () => ({ kind: "unchanged" }),
      interceptShell: async () => ({ kind: "rewritten", command: "rtk bun test", provider: "rtk" }),
      postProcess,
    });
    f.call().moveToBackground();
    f.pending.resolve(success);
    await f.handle().ended;
    expect(postProcess).not.toHaveBeenCalled();
  });
});
