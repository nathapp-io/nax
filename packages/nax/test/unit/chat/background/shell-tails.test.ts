/**
 * US-003: the registry's table of shell output tails, and the host wiring that exposes it.
 *
 * Every test drives the real registry (as `task-registry.test.ts` does) with only the log-file
 * seam stubbed, so the tail is fed through the sink `adopt` hands nax-agent — the entry point the
 * bytes really arrive through — rather than by reaching into the tail module.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackgroundCommandEnd } from "@nathapp/nax-agent";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import { type ChatResources, createChatHost, createChatStorage } from "@/chat";
import type { BackgroundAgentEnd } from "@/chat/background";
import { buildResourceCatalog } from "@/resources";

let registry: typeof import("@/chat/background");
let original: typeof registry._backgroundTaskDeps;
let logger: ReturnType<typeof makeLogger>;
let hexes: string[];
let counter: number;

const NOW = "2026-10-29T00:00:00.000Z";
const encoder = new TextEncoder();

beforeEach(async () => {
  registry = await import("@/chat/background");
  original = { ...registry._backgroundTaskDeps };
  logger = makeLogger();
  hexes = [];
  counter = 0;
  Object.assign(registry._backgroundTaskDeps, {
    randomHex: () => hexes.shift() ?? (counter++).toString(16).padStart(8, "0"),
    mkdir: () => undefined,
    appendLog: async () => {},
    readLog: async () => "",
  });
});

afterEach(() => {
  Object.assign(registry._backgroundTaskDeps, original);
});

type Tasks = ReturnType<typeof registry.createBackgroundTasks>;

/** A registry built on the stubbed seams; call after any `shellTailTotalMaxBytes` change. */
function makeTasks(): Tasks {
  return registry.createBackgroundTasks({ outputDir: "/o", now: () => new Date(NOW), logger });
}

interface Shell {
  readonly id: string;
  readonly append: (text: string) => void;
  /** Append raw bytes, for the output a decoder can only settle by ending the task. */
  readonly appendBytes: (bytes: Uint8Array) => void;
  readonly finish: () => Promise<void>;
}

/** Adopt one background shell through the registry's real `adopt`, as nax-agent does. */
function adoptShell(tasks: Tasks, origin: "agent" | "moved" = "agent"): Shell {
  const end = Promise.withResolvers<BackgroundCommandEnd>();
  const sink = tasks.adopt({ command: "echo hi", origin, ended: end.promise, stop: mock(() => {}) });
  return {
    id: sink.id,
    append: (text: string) => sink.append("stdout", encoder.encode(text)),
    appendBytes: (bytes: Uint8Array) => sink.append("stdout", bytes),
    finish: async () => {
      end.resolve({ exitCode: 0, timedOut: false, aborted: false });
      await end.promise;
      // Drains the registry's queued log writes, exactly as the existing registry tests do.
      await tasks.output(sink.id);
    },
  };
}

/** Adopt one background subagent run, whose id must never address a shell tail. */
function adoptAgent(tasks: Tasks): string {
  const sink = tasks.adoptAgent({
    agent: "general",
    task: "summarise the diff",
    ended: Promise.withResolvers<BackgroundAgentEnd>().promise,
    stop: mock(() => {}),
  });
  return sink.id;
}

describe("createBackgroundTasks shell tails", () => {
  test("AC-1 a sink append reaches the task's tail", () => {
    hexes = ["00000001"];
    const tasks = makeTasks();
    const shell = adoptShell(tasks);
    shell.append("hi\n");
    expect(shell.id).toBe("bash-00000001");
    expect(tasks.taskTail(shell.id)?.lines).toEqual(["hi"]);
  });

  test("AC-2 taskTail is undefined for an id the registry does not list", () => {
    const tasks = makeTasks();
    adoptShell(tasks);
    expect(tasks.taskTail("bash-0000000f")).toBeUndefined();
  });

  test("AC-3 taskTail is undefined for the id of an agent task", () => {
    const tasks = makeTasks();
    const id = adoptAgent(tasks);
    expect(tasks.get(id)?.kind).toBe("agent");
    expect(tasks.taskTail(id)).toBeUndefined();
  });

  test("AC-4 output appended after the task ended does not change its tail", async () => {
    const tasks = makeTasks();
    const shell = adoptShell(tasks);
    shell.append("hi\n");
    await shell.finish();
    shell.append("later\n");
    expect(tasks.taskTail(shell.id)?.lines).toEqual(["hi"]);
  });

  test("AC-5 each sink append notifies every listener with the task id", () => {
    const tasks = makeTasks();
    const shell = adoptShell(tasks);
    const first: string[] = [];
    const second: string[] = [];
    tasks.onShellOutput((id) => first.push(id));
    tasks.onShellOutput((id) => second.push(id));
    shell.append("hi\n");
    shell.append("ho\n");
    expect(first).toEqual([shell.id, shell.id]);
    expect(second).toEqual([shell.id, shell.id]);
  });

  test("AC-6 the returned unsubscribe stops further notifications", () => {
    const tasks = makeTasks();
    const shell = adoptShell(tasks);
    const seen: string[] = [];
    const off = tasks.onShellOutput((id) => seen.push(id));
    shell.append("hi\n");
    off();
    shell.append("ho\n");
    expect(seen).toEqual([shell.id]);
  });

  test("AC-7 a throwing listener is logged at warn and the others are still notified", () => {
    const tasks = makeTasks();
    const shell = adoptShell(tasks);
    const seen: string[] = [];
    tasks.onShellOutput(() => {
      throw new Error("boom");
    });
    tasks.onShellOutput((id) => seen.push(id));
    shell.append("hi\n");
    expect(seen).toEqual([shell.id]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("AC-8 a moved command's replayed chunks reach the task's tail", () => {
    const tasks = makeTasks();
    const shell = adoptShell(tasks, "moved");
    expect(tasks.get(shell.id)?.origin).toBe("moved");
    shell.append("a\n");
    shell.append("b\n");
    expect(tasks.taskTail(shell.id)?.lines).toEqual(["a", "b"]);
  });

  test("AC-9 the earlier-ended task's tail is evicted first", async () => {
    registry._backgroundTaskDeps.shellTailTotalMaxBytes = 8;
    const tasks = makeTasks();
    const earlier = adoptShell(tasks);
    const later = adoptShell(tasks);
    earlier.append("aaaaa\n");
    later.append("bbbbb\n");
    await earlier.finish();
    await later.finish();
    expect(tasks.taskTail(earlier.id)?.lines).toEqual([]);
    expect(tasks.taskTail(later.id)?.lines).toEqual(["bbbbb"]);
  });

  test("AC-10 an evicted task's tail reports truncated", async () => {
    registry._backgroundTaskDeps.shellTailTotalMaxBytes = 8;
    const tasks = makeTasks();
    const earlier = adoptShell(tasks);
    const later = adoptShell(tasks);
    earlier.append("aaaaa\n");
    later.append("bbbbb\n");
    await earlier.finish();
    await later.finish();
    expect(tasks.taskTail(earlier.id)?.truncated).toBe(true);
  });

  test("AC-11 a running task's tail is never evicted, even while over the limit", async () => {
    registry._backgroundTaskDeps.shellTailTotalMaxBytes = 8;
    const tasks = makeTasks();
    const ended = adoptShell(tasks);
    ended.append("aaaaa\n");
    await ended.finish();
    const running = adoptShell(tasks);
    running.append("0123456789abc\n");
    expect(tasks.taskTail(running.id)?.lines).toEqual(["0123456789abc"]);
    expect(tasks.taskTail(ended.id)?.lines).toEqual([]);
  });

  test("AC-12 exports a 4 MiB total tail budget", () => {
    expect(registry.SHELL_TAIL_TOTAL_MAX_BYTES).toBe(4194304);
  });

  test("AC-14 a throwing listener does not stop the append reaching the tail", () => {
    const tasks = makeTasks();
    const shell = adoptShell(tasks);
    tasks.onShellOutput(() => {
      throw new Error("boom");
    });
    shell.append("hi\n");
    expect(tasks.taskTail(shell.id)?.lines).toEqual(["hi"]);
  });

  test("AC-15 the end of a task flushes a character the output left incomplete", async () => {
    const tasks = makeTasks();
    const shell = adoptShell(tasks);
    // "a" then the first byte of a two-byte character, and then the shell exits: the byte can
    // only be settled by the decoder being flushed, which is the task's end.
    shell.appendBytes(new Uint8Array([0x61, 0xc3]));
    expect(tasks.taskTail(shell.id)?.lines).toEqual(["a"]);
    await shell.finish();
    expect(tasks.taskTail(shell.id)?.lines).toEqual(["a\ufffd"]);
  });
});

describe("ChatHost.shellOutput", () => {
  test("AC-13 the host reads an adopted task's tail through shellOutput", () => {
    const resources: ChatResources = {
      catalog: buildResourceCatalog([]),
      toolProviders: [],
      pluginHandlers: [],
      naxPlugins: [],
      teardown: async () => {},
    };
    const now = () => new Date(NOW);
    const host = createChatHost({
      config: makeNaxConfig(),
      cwd: "/r",
      repoRoot: "/r",
      chain: null,
      storage: createChatStorage({ pid: process.pid, now, logger: makeLogger() }),
      now,
      logger: makeLogger(),
      resources,
    });
    const tasks = host.tasks;
    const shellOutput = host.shellOutput;
    assertDefined(tasks, "host.tasks");
    assertDefined(shellOutput, "host.shellOutput");
    const sink = tasks.adopt({
      command: "echo hi",
      origin: "agent",
      ended: Promise.withResolvers<BackgroundCommandEnd>().promise,
      stop: mock(() => {}),
    });
    sink.append("stdout", encoder.encode("hi\n"));
    expect(Object.is(shellOutput, tasks)).toBe(true);
    expect(shellOutput.taskTail(sink.id)?.lines).toEqual(["hi"]);
  });
});
