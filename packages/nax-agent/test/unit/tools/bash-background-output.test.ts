/**
 * US-001 — a foreground Bash call hands the host its tool-call id and its
 * output as it arrives.
 *
 * The runtime is the real one, the Bash tool is the real one, and the only
 * seams are `_bashToolDeps.runArgv` (a launch that reports chunks through the
 * `onOutput` it is given and then waits on a test-controlled gate) and a fake
 * `BackgroundCommandPort` that records the `ForegroundCommand` registered
 * through `foreground(call)` and the sink it adopts on a move.
 *
 * Nothing here changes what the model receives: AC-9 pins that.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ArgvExecResult, RunArgvOptions } from "#src/internal/argv-exec";
import { _bashToolDeps, createBashTool } from "#src/tools/bash";
import type { BackgroundCommandPort, BackgroundStream, ForegroundCommand } from "#src/tools/bash-background";
import { compileToolPolicy, createCodingToolRuntime } from "#src/tools/index";
import type { ToolCallContext } from "#src/tools/types";
import { assertDefined, cleanupTempDir, makeTempDir } from "#test/helpers/index";

const realRunArgv = _bashToolDeps.runArgv;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const success: ArgvExecResult = { exitCode: 0, stdout: "x", stderr: "", timedOut: false };

let root = "";
/** Launches that never settled; afterEach opens their gate so no run leaks. */
const openGates: (() => void)[] = [];

beforeEach(() => {
  root = makeTempDir("nax-bash-output-");
});

afterEach(() => {
  for (const open of openGates.splice(0)) open();
  _bashToolDeps.runArgv = realRunArgv;
  cleanupTempDir(root);
});

async function drain() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

interface Chunk {
  readonly stream: BackgroundStream;
  readonly text: string;
}

function makeHarness() {
  const calls: ForegroundCommand[] = [];
  const appended: Chunk[] = [];
  const launch = Promise.withResolvers<ArgvExecResult>();
  let launchOutput: ((stream: BackgroundStream, chunk: Uint8Array) => void) | undefined;
  let outcome: { content?: string; kind?: string } = {};

  const port: BackgroundCommandPort = {
    adopt: () => ({
      id: "bash-live01",
      append: (stream, chunk) => appended.push({ stream, text: decoder.decode(chunk) }),
    }),
    foreground: (call) => {
      calls.push(call);
      return () => {};
    },
  };

  _bashToolDeps.runArgv = (options: RunArgvOptions) => {
    launchOutput = options.onOutput;
    return launch.promise;
  };

  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
    extraTools: [createBashTool({ background: port })],
  });
  runtime.advertised(["Bash"]);

  return {
    appended,
    /** Starts the call and drains microtasks until `foreground(call)` has run. */
    async start(context?: ToolCallContext) {
      // A run the test never settles must not leak: afterEach opens its gate.
      openGates.push(() => launch.resolve(success));
      void runtime.callTool("Bash", { command: "build" }, context).then((value) => {
        outcome = value;
      });
      await drain();
    },
    call(): ForegroundCommand {
      const call = calls[0];
      assertDefined(call);
      return call;
    },
    emit(stream: BackgroundStream, text: string) {
      assertDefined(launchOutput, "the launch has not reported its onOutput yet");
      launchOutput(stream, encoder.encode(text));
    },
    /** Resolves the launch gate and waits for the tool result. */
    async settle(): Promise<{ content?: string; kind?: string }> {
      launch.resolve(success);
      await drain();
      return outcome;
    },
    rows(rows: Chunk[]): [BackgroundStream, string][] {
      return rows.map((row) => [row.stream, row.text]);
    },
  };
}

function subscribe(call: ForegroundCommand, into: Chunk[]): () => void {
  const onOutput = call.onOutput;
  assertDefined(onOutput, "the registered ForegroundCommand has no onOutput");
  return onOutput((stream, chunk) => {
    into.push({ stream, text: decoder.decode(chunk) });
  });
}

function subscribeThrowing(call: ForegroundCommand): () => void {
  const onOutput = call.onOutput;
  assertDefined(onOutput, "the registered ForegroundCommand has no onOutput");
  return onOutput(() => {
    throw new Error("listener exploded");
  });
}

describe("US-001 AC-1/AC-2: the registered foreground call carries the tool-call id", () => {
  test("AC-1: a call with toolCallId c1 registers a ForegroundCommand whose callId is c1", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    expect(h.call().callId).toBe("c1");
    await h.settle();
  });

  test("AC-2: that ForegroundCommand's command is build", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const call = h.call();
    expect(call.callId).toBe("c1");
    expect(call.command).toBe("build");
    await h.settle();
  });
});

describe("US-001 AC-3/AC-4: a call with no tool-call id still registers an observable call", () => {
  test("AC-3: a call with no call context registers a ForegroundCommand with no callId member", async () => {
    // Discriminating on both sides: the same runtime path WITH a tool-call id
    // does carry the member, so "absent" is a decision and not just today's
    // shape.
    const identified = makeHarness();
    await identified.start({ toolCallId: "c1" });
    expect("callId" in identified.call()).toBe(true);

    const anonymous = makeHarness();
    await anonymous.start();
    const call = anonymous.call();
    expect("callId" in call).toBe(false);
    expect(call.callId).toBeUndefined();
    await identified.settle();
    await anonymous.settle();
  });

  test("AC-4: that call-id-less ForegroundCommand still has an onOutput function", async () => {
    const h = makeHarness();
    await h.start();
    expect(typeof h.call().onOutput).toBe("function");
    await h.settle();
  });
});

describe("US-001 AC-5/AC-6: a listener observes chunks in order, and unsubscribing stops delivery", () => {
  test("AC-5: a listener receives each reported chunk, in order, with its stream", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const received: Chunk[] = [];
    subscribe(h.call(), received);
    h.emit("stdout", "one");
    h.emit("stderr", "two");
    h.emit("stdout", "three");
    expect(h.rows(received)).toEqual([
      ["stdout", "one"],
      ["stderr", "two"],
      ["stdout", "three"],
    ]);
    await h.settle();
  });

  test("AC-6: after unsubscribe, later chunks are not delivered to that listener", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const received: Chunk[] = [];
    const unsubscribe = subscribe(h.call(), received);
    h.emit("stdout", "first");
    unsubscribe();
    h.emit("stdout", "second");
    expect(h.rows(received)).toEqual([["stdout", "first"]]);
    await h.settle();
  });
});

describe("US-001 AC-7/AC-8: moving to the background stops observation and replays what came before", () => {
  test("AC-7: after moveToBackground, later chunks reach the background sink and not the listener", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const received: Chunk[] = [];
    subscribe(h.call(), received);
    h.emit("stdout", "before");
    h.call().moveToBackground();
    h.emit("stderr", "after");
    expect(h.rows(received)).toEqual([["stdout", "before"]]);
    expect(h.rows(h.appended)).toEqual([
      ["stdout", "before"],
      ["stderr", "after"],
    ]);
    await h.settle();
  });

  test("AC-8: the background sink first receives every pre-move chunk, in order", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const received: Chunk[] = [];
    subscribe(h.call(), received);
    h.emit("stdout", "one");
    h.emit("stderr", "two");
    h.call().moveToBackground();
    expect(h.rows(h.appended)).toEqual([
      ["stdout", "one"],
      ["stderr", "two"],
    ]);
    await h.settle();
  });
});

describe("US-001 AC-9: observing output does not change the tool result", () => {
  test("AC-9: a foreground Bash call returns the same text with and without a listener", async () => {
    const bare = makeHarness();
    await bare.start({ toolCallId: "c1" });
    const withoutListener = await bare.settle();

    const watched = makeHarness();
    await watched.start({ toolCallId: "c2" });
    const received: Chunk[] = [];
    subscribe(watched.call(), received);
    watched.emit("stdout", "streamed");
    const withListener = await watched.settle();

    expect(received).toHaveLength(1);
    expect(withListener.content).toBe(withoutListener.content);
    expect(withListener.kind).toBe("ok");
  });
});

describe("US-001 AC-8: observation is non-invasive — a listener cannot alter what is replayed", () => {
  test("AC-8: a listener that mutates its chunk cannot corrupt the bytes replayed to the sink", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const onOutput = h.call().onOutput;
    assertDefined(onOutput, "the registered ForegroundCommand has no onOutput");
    onOutput((_stream, chunk) => {
      chunk.fill(0);
    });
    h.emit("stdout", "payload");
    h.call().moveToBackground();
    expect(h.rows(h.appended)).toEqual([["stdout", "payload"]]);
    await h.settle();
  });

  test("AC-8: a listener that mutates its chunk does not alter another listener's bytes", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const onOutput = h.call().onOutput;
    assertDefined(onOutput, "the registered ForegroundCommand has no onOutput");
    onOutput((_stream, chunk) => {
      chunk.fill(0);
    });
    const received: Chunk[] = [];
    subscribe(h.call(), received);
    h.emit("stderr", "intact");
    expect(h.rows(received)).toEqual([["stderr", "intact"]]);
    await h.settle();
  });
});

describe("US-001 AC-10/AC-11: a throwing listener is contained", () => {
  test("AC-10: a throwing listener does not prevent the move's replay of that chunk", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    subscribeThrowing(h.call());
    h.emit("stdout", "kept");
    h.call().moveToBackground();
    expect(h.rows(h.appended)).toEqual([["stdout", "kept"]]);
    await h.settle();
  });

  test("AC-11: when one of two listeners throws, the other still receives the chunk", async () => {
    const h = makeHarness();
    await h.start({ toolCallId: "c1" });
    const received: Chunk[] = [];
    subscribeThrowing(h.call());
    subscribe(h.call(), received);
    h.emit("stderr", "still delivered");
    expect(h.rows(received)).toEqual([["stderr", "still delivered"]]);
    await h.settle();
  });
});
