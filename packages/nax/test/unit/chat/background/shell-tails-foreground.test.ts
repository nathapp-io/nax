/**
 * US-004: a running foreground Bash call keeps a shell tail addressed by its tool call id.
 *
 * The unit tests drive the real registry with a foreground fake — a `ForegroundCommand` whose
 * `onOutput` records the listener and whose unsubscribe counts its calls — so "did the registry
 * subscribe?" and "did it unsubscribe?" are observable without reaching into `shell-tails.ts`.
 * The three integration cases run the REAL Bash tool over the real registry as its background
 * port, stubbing only `_bashToolDeps.runArgv`, exactly as `test/unit/tools/bash-intercept.test.ts`
 * already does: the call id therefore has to travel the whole way from `ToolRunContext` to the
 * registry, which is the seam US-001 and US-004 meet on.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackgroundCommandEnd, ForegroundCommand } from "@nathapp/nax-agent";
import { _bashToolDeps, createBashTool } from "@nathapp/nax-agent/internal";
import { makeLogger, withDepsRestore } from "@test/helpers";
import { _backgroundTaskDeps, createBackgroundTasks } from "@/chat/background";

const encoder = new TextEncoder();
const NOW = "2026-10-29T00:00:00.000Z";

let logger: ReturnType<typeof makeLogger>;
let original: typeof _backgroundTaskDeps;
let hexes: string[];

beforeEach(() => {
  original = { ..._backgroundTaskDeps };
  logger = makeLogger();
  hexes = [];
  Object.assign(_backgroundTaskDeps, {
    randomHex: () => hexes.shift() ?? "0000000f",
    mkdir: () => undefined,
    appendLog: async () => {},
    readLog: async () => "",
  });
});

afterEach(() => {
  Object.assign(_backgroundTaskDeps, original);
});

type Tasks = ReturnType<typeof createBackgroundTasks>;

/** A registry built on the stubbed seams; call after any `shellTailTotalMaxBytes` change. */
function makeTasks(): Tasks {
  return createBackgroundTasks({ outputDir: "/o", now: () => new Date(NOW), logger });
}

type OutputListener = Parameters<NonNullable<ForegroundCommand["onOutput"]>>[0];

interface ForegroundFake {
  readonly call: ForegroundCommand;
  /** The listener the registry subscribed, when it subscribed. */
  readonly listeners: readonly OutputListener[];
  readonly subscriptions: () => number;
  readonly unsubscriptions: () => number;
  /** Deliver one chunk to every subscribed listener, as nax-agent's `append` does. */
  readonly deliver: (text: string) => void;
  readonly moved: () => number;
}

/**
 * A `ForegroundCommand` shaped like the one nax-agent registers: `callId` and `onOutput` are
 * both optional there, so the fake can leave either out.
 */
function makeForeground(options: { readonly callId?: string; readonly observe?: boolean } = {}): ForegroundFake {
  const listeners: OutputListener[] = [];
  let subscriptions = 0;
  let unsubscriptions = 0;
  const moved = mock(() => {});
  const call: ForegroundCommand = {
    command: "echo hi",
    ...(options.callId !== undefined ? { callId: options.callId } : {}),
    moveToBackground: moved,
    ...(options.observe === false
      ? {}
      : {
          onOutput(listener: OutputListener): () => void {
            subscriptions += 1;
            listeners.push(listener);
            return () => {
              unsubscriptions += 1;
            };
          },
        }),
  };
  return {
    call,
    listeners,
    subscriptions: () => subscriptions,
    unsubscriptions: () => unsubscriptions,
    moved: () => moved.mock.calls.length,
    deliver(text) {
      const chunk = encoder.encode(text);
      for (const listener of listeners) listener("stdout", chunk);
    },
  };
}

/** The newest call's tail lines, or a readable failure rather than a bare undefined deref. */
function lines(tasks: Tasks, callId: string): readonly string[] | undefined {
  return tasks.foregroundTail(callId)?.lines;
}

describe("foreground call tails (US-004)", () => {
  test("AC-1 a call carrying a call id is subscribed through onOutput exactly once", () => {
    const tasks = makeTasks();
    const fake = makeForeground({ callId: "c1" });
    tasks.foreground(fake.call);
    expect(fake.subscriptions()).toBe(1);
    expect(fake.listeners).toHaveLength(1);
  });

  test("AC-2 a delivered chunk reaches the tail addressed by the call id", () => {
    const tasks = makeTasks();
    const fake = makeForeground({ callId: "c1" });
    tasks.foreground(fake.call);
    fake.deliver("x\n");
    expect(lines(tasks, "c1")).toEqual(["x"]);
  });

  test("AC-3 a delivered chunk notifies the shell-output listeners with the call id", () => {
    const tasks = makeTasks();
    const fake = makeForeground({ callId: "c1" });
    const seen: string[] = [];
    tasks.onShellOutput((id) => seen.push(id));
    tasks.foreground(fake.call);
    fake.deliver("x\n");
    expect(seen).toEqual(["c1"]);
  });

  test("AC-4 the unregister function calls the call's own unsubscribe", () => {
    const tasks = makeTasks();
    const fake = makeForeground({ callId: "c1" });
    const unregister = tasks.foreground(fake.call);
    expect(fake.unsubscriptions()).toBe(0);
    unregister();
    expect(fake.unsubscriptions()).toBe(1);
  });

  test("AC-5 after the unregister the call id addresses no tail", () => {
    const tasks = makeTasks();
    const fake = makeForeground({ callId: "c1" });
    const unregister = tasks.foreground(fake.call);
    fake.deliver("x\n");
    // Premise: the tail really existed before the unregister released it.
    expect(lines(tasks, "c1")).toEqual(["x"]);
    unregister();
    expect(tasks.foregroundTail("c1")).toBeUndefined();
  });

  test("AC-6 a call with no onOutput registers exactly as before", () => {
    const tasks = makeTasks();
    const fake = makeForeground({ callId: "c1", observe: false });
    tasks.foreground(fake.call);
    expect(fake.subscriptions()).toBe(0);
    expect(tasks.hasForeground()).toBe(true);
    expect(tasks.foregroundTail("c1")).toBeUndefined();
    // The registration still works: the control path must be untouched.
    expect(tasks.moveForeground()).toBe(true);
    expect(fake.moved()).toBe(1);
  });

  test("AC-7 an observed call with no call id still subscribes, and addresses no tail", () => {
    const tasks = makeTasks();
    const fake = makeForeground();
    tasks.foreground(fake.call);
    expect(fake.subscriptions()).toBe(1);
    fake.deliver("x\n");
    expect(tasks.foregroundTail("c1")).toBeUndefined();
    expect(tasks.foregroundTail("")).toBeUndefined();
    expect(tasks.foregroundTail("undefined")).toBeUndefined();
  });

  test("AC-8 (control) moveForeground moves the newest registered observed call", () => {
    const tasks = makeTasks();
    const first = makeForeground({ callId: "c1" });
    const last = makeForeground({ callId: "c2" });
    tasks.foreground(first.call);
    tasks.foreground(last.call);
    expect(tasks.moveForeground()).toBe(true);
    expect(last.moved()).toBe(1);
    expect(first.moved()).toBe(0);
  });

  test("AC-11 a foreground tail is never evicted by the total budget", async () => {
    _backgroundTaskDeps.shellTailTotalMaxBytes = 8;
    const tasks = makeTasks();
    // A finished task first, so there IS something for the eviction queue to drop.
    const end = Promise.withResolvers<BackgroundCommandEnd>();
    const sink = tasks.adopt({ command: "echo a", origin: "agent", ended: end.promise, stop: mock(() => {}) });
    sink.append("stdout", encoder.encode("aaaaa\n"));
    end.resolve({ exitCode: 0, timedOut: false, aborted: false });
    // Drains the registry's queued work, exactly as the existing registry tests do.
    await tasks.output(sink.id);
    const fake = makeForeground({ callId: "c1" });
    tasks.foreground(fake.call);
    fake.deliver("0123456789\n");
    expect(lines(tasks, "c1")).toEqual(["0123456789"]);
    expect(tasks.foregroundTail("c1")?.truncated).toBe(false);
    // Premise: the budget really is being enforced — the finished task's 5-byte tail is gone.
    expect(tasks.taskTail(sink.id)?.lines).toEqual([]);
  });
});

describe("a real foreground Bash call's tail (US-004)", () => {
  withDepsRestore(_bashToolDeps, ["runArgv"]);

  /** The run context a session hands the Bash tool; only the call id varies here. */
  function toolCtx(toolCallId?: string) {
    return {
      root: "/r",
      resolvedPaths: [],
      maxBytes: 40_000,
      maxFileBytes: 2_000_000,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    };
  }

  /**
   * Stub the spawn seam to report `reported` on stdout and then wait, exactly as a real
   * long-running command does: `delivered` resolves once the tool has been told the output,
   * `release` lets the launch finish.
   */
  function gatedLaunch(reported: string): { readonly delivered: Promise<void>; readonly release: () => void } {
    const delivered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    _bashToolDeps.runArgv = async (options) => {
      options.onOutput?.("stdout", encoder.encode(reported));
      delivered.resolve();
      await release.promise;
      return { exitCode: 0, stdout: reported, stderr: "", timedOut: false };
    };
    return { delivered: delivered.promise, release: () => release.resolve() };
  }

  test("AC-9 the Bash call's live output is retained under its tool call id", async () => {
    const tasks = makeTasks();
    const launch = gatedLaunch("line one\n");
    const run = createBashTool({ background: tasks }).run({ command: "echo hi" }, toolCtx("c1"));

    await launch.delivered;
    expect(tasks.foregroundTail("c1")?.lines).toEqual(["line one"]);

    launch.release();
    await run;
  });

  test("AC-10 the tail is released once the Bash call returns", async () => {
    const tasks = makeTasks();
    const launch = gatedLaunch("line one\n");
    const run = createBashTool({ background: tasks }).run({ command: "echo hi" }, toolCtx("c1"));

    await launch.delivered;
    // Premise: the tail existed while the call ran, so "undefined after" is a release, not an absence.
    expect(tasks.foregroundTail("c1")?.lines).toEqual(["line one"]);

    launch.release();
    await run;
    expect(tasks.foregroundTail("c1")).toBeUndefined();
  });

  test("AC-12 moving a foreground Bash call to the background releases its call-id tail", async () => {
    const tasks = makeTasks();
    hexes = ["00000001"];
    const launch = gatedLaunch("line one\n");
    const run = createBashTool({ background: tasks }).run({ command: "echo hi" }, toolCtx("c1"));

    await launch.delivered;
    expect(tasks.foregroundTail("c1")?.lines).toEqual(["line one"]);
    expect(tasks.moveForeground()).toBe(true);
    const result = await run;
    // Premise: the move really adopted a background task, so the registration ended by moving.
    expect(result).toMatchObject({ content: "moved to the background as bash-00000001" });
    expect(tasks.list().map((task) => task.origin)).toEqual(["moved"]);
    expect(tasks.hasForeground()).toBe(false);
    expect(tasks.foregroundTail("c1")).toBeUndefined();

    launch.release();
  });
});
