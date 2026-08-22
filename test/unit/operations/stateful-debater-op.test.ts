import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, debateConfigSelector } from "@/config";
import { NaxError } from "@/errors";
import * as operationsModule from "@/operations";

interface PromiseWithResolvers<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface StatefulDebaterInput {
  readonly debater: { readonly agent: string; readonly model?: string };
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (peerProposals: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly signal: AbortSignal;
  readonly storyId: string;
  readonly skipRebuttal?: boolean;
  readonly turnSemaphore?: { readonly run: <T>(task: () => Promise<T>) => Promise<T> };
}

interface StatefulDebaterOutput {
  readonly success: boolean;
  readonly rebut: string;
}

interface StatefulDebaterOp {
  readonly kind: "run";
  readonly name: string;
  readonly stage: string;
  readonly session: { readonly role: string; readonly lifetime: "fresh" | "warm" };
  readonly config: unknown;
  readonly model?: (input: StatefulDebaterInput) => { readonly agent: string; readonly model: string };
  readonly build: (
    input: StatefulDebaterInput,
    ctx: unknown,
  ) => {
    readonly role: { readonly id: string; readonly content: string; readonly overridable: boolean };
    readonly task: { readonly id: string; readonly content: string; readonly overridable: boolean };
  };
  readonly hopBody?: (
    initialPrompt: string,
    ctx: {
      readonly send: (prompt: string) => Promise<{ readonly output: string }>;
      readonly input: StatefulDebaterInput;
    },
  ) => Promise<{ readonly output: string }>;
  readonly parse: (output: string, input: StatefulDebaterInput, ctx: unknown) => StatefulDebaterOutput;
}

function makeBarrier<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBuildCtx() {
  return {
    packageView: {
      config: DEFAULT_CONFIG,
      select: (_sel: unknown) => DEFAULT_CONFIG.debate,
    },
    config: DEFAULT_CONFIG.debate,
  } as Parameters<NonNullable<StatefulDebaterOp["build"]>>[1];
}

function getStatefulDebaterOp(): StatefulDebaterOp {
  const op = (operationsModule as Record<string, unknown>).statefulDebaterOp;
  expect(op).toBeDefined();
  return op as StatefulDebaterOp;
}

function makeInput(overrides: Partial<StatefulDebaterInput> = {}): StatefulDebaterInput {
  const proposalBarriers = [makeBarrier<string>(), makeBarrier<string>(), makeBarrier<string>()];
  return {
    debater: { agent: "claude" },
    index: 0,
    proposePrompt: "## Propose\nMake the case.",
    buildRebutPrompt: (peerProposals: string[]) => `## Rebut\n${peerProposals.join(" | ")}`,
    proposalBarriers,
    signal: new AbortController().signal,
    storyId: "US-855",
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe("statefulDebaterOp", () => {
  test("is exported from operations barrel with the expected identity", () => {
    const op = getStatefulDebaterOp();

    expect(op.kind).toBe("run");
    expect(op.name).toBe("debate-stateful");
    expect(op.stage).toBe("review");
    expect(op.session).toEqual({ role: "debate-stateful", lifetime: "fresh" });
    expect(op.config).toBe(debateConfigSelector);
  });

  test("model returns the debater agent and defaults the model to fast", () => {
    const op = getStatefulDebaterOp();
    const input = makeInput({ debater: { agent: "opencode" } });

    expect(op.model?.(input)).toEqual({ agent: "opencode", model: "fast" });
  });

  test("model preserves an explicit debater model", () => {
    const op = getStatefulDebaterOp();
    const input = makeInput({ debater: { agent: "opencode", model: "balanced" } });

    expect(op.model?.(input)).toEqual({ agent: "opencode", model: "balanced" });
  });

  test("build forwards the propose prompt into the task slot", () => {
    const op = getStatefulDebaterOp();
    const input = makeInput();

    const built = op.build(input, makeBuildCtx());

    expect(built.role).toEqual({ id: "role", content: "", overridable: false });
    expect(built.task).toEqual({
      id: "task",
      content: input.proposePrompt,
      overridable: false,
    });
  });

  test("hopBody sends the proposal prompt first, resolves the local proposal barrier, and then sends the rebut prompt built from peer proposals", async () => {
    const op = getStatefulDebaterOp();
    const localBarrier = makeBarrier<string>();
    const peerOne = makeBarrier<string>();
    const peerTwo = makeBarrier<string>();
    const sendCalls: string[] = [];
    const localResolutionCalls: string[] = [];
    const originalResolve = localBarrier.resolve;
    localBarrier.resolve = mock((value: string | PromiseLike<string>) => {
      localResolutionCalls.push(String(value));
      originalResolve(value);
    });

    const input = makeInput({
      index: 0,
      proposalBarriers: [localBarrier, peerOne, peerTwo],
      buildRebutPrompt: (peerProposals: string[]) => `rebut:${peerProposals.join(",")}`,
    });

    const hop = op.hopBody?.(input.proposePrompt, {
      input,
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        if (sendCalls.length === 1) {
          return { output: "proposal-0" };
        }
        return { output: "rebut-0" };
      }),
    });

    expect(hop).toBeDefined();
    await Promise.resolve();

    expect(sendCalls).toEqual([input.proposePrompt]);

    peerOne.resolve("proposal-1");
    peerTwo.resolve("proposal-2");

    await expect(hop as Promise<{ readonly output: string }>).resolves.toEqual({ output: "rebut-0" });
    expect(sendCalls).toEqual([input.proposePrompt, "rebut:proposal-0,proposal-1,proposal-2"]);
    expect(localResolutionCalls).toEqual(["proposal-0"]);
  });

  test("hopBody throws CALL_OP_ABORTED and does not send the rebut prompt when the signal is already aborted", async () => {
    const op = getStatefulDebaterOp();
    const controller = new AbortController();
    controller.abort();
    const sendCalls: string[] = [];
    const input = makeInput({
      signal: controller.signal,
      proposalBarriers: [makeBarrier<string>(), makeBarrier<string>(), makeBarrier<string>()],
    });

    const hop = op.hopBody?.(input.proposePrompt, {
      input,
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        return { output: "proposal-0" };
      }),
    });

    await expect(hop as Promise<{ readonly output: string }>).rejects.toBeInstanceOf(NaxError);
    await expect(hop as Promise<{ readonly output: string }>).rejects.toMatchObject({ code: "CALL_OP_ABORTED" });
    expect(sendCalls).toEqual([input.proposePrompt]);
  });

  test("hopBody returns the proposal directly when skipRebuttal is enabled", async () => {
    const op = getStatefulDebaterOp();
    const localBarrier = makeBarrier<string>();
    const peerBarrier = makeBarrier<string>();
    const sendCalls: string[] = [];
    const input = makeInput({
      proposalBarriers: [localBarrier, peerBarrier, makeBarrier<string>()],
      skipRebuttal: true,
    });

    const hop = op.hopBody?.(input.proposePrompt, {
      input,
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        return { output: "proposal-only" };
      }),
    });

    peerBarrier.resolve("peer-proposal");

    await expect(hop as Promise<{ readonly output: string }>).resolves.toEqual({ output: "proposal-only" });
    await expect(localBarrier.promise).resolves.toBe("proposal-only");
    expect(sendCalls).toEqual([input.proposePrompt]);
  });

  test("parse returns success false when buildHopCallback prefixes the output with Agent quote text", () => {
    const op = getStatefulDebaterOp();
    const input = makeInput();

    expect(op.parse('Agent "claude" failed to respond', input, makeBuildCtx())).toEqual({
      success: false,
      rebut: 'Agent "claude" failed to respond',
    });
  });

  test("parse returns success true for a normal rebuttal output", () => {
    const op = getStatefulDebaterOp();
    const input = makeInput();

    expect(op.parse("the rebuttal is ready", input, makeBuildCtx())).toEqual({
      success: true,
      rebut: "the rebuttal is ready",
    });
  });
});
