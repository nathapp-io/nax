import { afterEach, describe, expect, mock, test } from "bun:test";
import { debateConfigSelector, DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import * as operationsModule from "@/operations";
import type { Debater } from "@/debate/types";

interface PromiseWithResolvers<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface DebateHybridInput {
  readonly debater: Debater;
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (round: number, peerOutputs: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly rebutBarriers: PromiseWithResolvers<string>[][];
  readonly signal: AbortSignal;
  readonly storyId: string;
  readonly rounds: number;
}

interface DebateHybridOutput {
  readonly success: boolean;
  readonly rebut: string;
}

interface DebateHybridOp {
  readonly kind: "run";
  readonly name: string;
  readonly stage: string;
  readonly session: { readonly role: string; readonly lifetime: "fresh" };
  readonly config: unknown;
  readonly model?: (input: DebateHybridInput) => { readonly agent: string; readonly model: string };
  readonly build: (input: DebateHybridInput, ctx: unknown) => {
    readonly role: { readonly id: string; readonly content: string; readonly overridable: boolean };
    readonly task: { readonly id: string; readonly content: string; readonly overridable: boolean };
  };
  readonly hopBody?: (
    initialPrompt: string,
    ctx: {
      readonly send: (prompt: string) => Promise<{ readonly output: string }>;
      readonly input: DebateHybridInput;
    },
  ) => Promise<{ readonly output: string }>;
  readonly parse: (output: string, input: DebateHybridInput, ctx: unknown) => DebateHybridOutput;
}

function defer<T>(): PromiseWithResolvers<T> {
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
  };
}

function getHybridDebaterOp(): DebateHybridOp {
  const op = (operationsModule as Record<string, unknown>).hybridDebaterOp;
  expect(op).toBeDefined();
  return op as DebateHybridOp;
}

function makeInput(overrides: Partial<DebateHybridInput> = {}): DebateHybridInput {
  const proposalBarriers = [defer<string>(), defer<string>()];
  const rebutBarriers = [
    [defer<string>(), defer<string>()],
    [defer<string>(), defer<string>()],
  ];

  return {
    debater: { agent: "claude", model: "fast" },
    index: 0,
    proposePrompt: "## Propose\nMake the case.",
    buildRebutPrompt: (round: number, peerOutputs: string[]) => `round-${round}:${peerOutputs.join("|")}`,
    proposalBarriers,
    rebutBarriers,
    signal: new AbortController().signal,
    storyId: "US-hybrid",
    rounds: 2,
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe("hybridDebaterOp", () => {
  test("is exported from the operations barrel with the expected identity", () => {
    const op = getHybridDebaterOp();

    expect(op.kind).toBe("run");
    expect(op.name).toBe("debate-hybrid");
    expect(op.stage).toBe("review");
    expect(op.session).toEqual({ role: "debate-hybrid", lifetime: "fresh" });
    expect(op.config).toBe(debateConfigSelector);
  });

  test("model returns the debater agent and defaults the model to fast", () => {
    const op = getHybridDebaterOp();
    const input = makeInput({ debater: { agent: "opencode" } });

    expect(op.model?.(input)).toEqual({ agent: "opencode", model: "fast" });
  });

  test("build forwards the proposal prompt into the task slot", () => {
    const op = getHybridDebaterOp();
    const input = makeInput();

    const built = op.build(input, makeBuildCtx());

    expect(built.role).toEqual({ id: "role", content: "", overridable: false });
    expect(built.task).toEqual({
      id: "task",
      content: input.proposePrompt,
      overridable: false,
    });
  });

  test("hopBody waits for proposal barriers, resolves the current round slot before the next round, and reuses settled round outputs", async () => {
    const op = getHybridDebaterOp();
    const proposalSelf = defer<string>();
    const proposalPeer = defer<string>();
    const round1Self = defer<string>();
    const round1Peer = defer<string>();
    const round2Self = defer<string>();
    const round2Peer = defer<string>();
    const sendCalls: string[] = [];
    const settledSlots: string[] = [];
    const originalResolve = round1Self.resolve;
    round1Self.resolve = (value) => {
      settledSlots.push(String(value));
      originalResolve(value);
    };

    const input = makeInput({
      proposalBarriers: [proposalSelf, proposalPeer],
      rebutBarriers: [
        [round1Self, round1Peer],
        [round2Self, round2Peer],
      ],
      buildRebutPrompt: (round, peerOutputs) => `round-${round}:${peerOutputs.join(",")}`,
    });

    const hop = op.hopBody?.("ignored", {
      input,
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        return { output: `rebut-${sendCalls.length}` };
      }),
    });

    expect(hop).toBeDefined();
    await Promise.resolve();
    expect(sendCalls).toEqual([]);

    proposalSelf.resolve("proposal-0");
    proposalPeer.resolve("proposal-1");

    await Promise.resolve();
    expect(sendCalls).toEqual(["round-1:proposal-0,proposal-1"]);
    expect(settledSlots).toEqual(["rebut-1"]);

    await Promise.resolve();
    expect(sendCalls).toEqual(["round-1:proposal-0,proposal-1"]);

    round1Peer.resolve("round-1-peer");
    await Promise.resolve();

    expect(sendCalls).toEqual([
      "round-1:proposal-0,proposal-1",
      "round-2:rebut-1,round-1-peer",
    ]);
    expect(settledSlots).toEqual(["rebut-1", "rebut-2"]);

    await expect(hop as Promise<{ readonly output: string }>).resolves.toEqual({ output: "rebut-2" });
  });

  test("hopBody throws CALL_OP_ABORTED and stops before the next round when the signal aborts between rebuttal rounds", async () => {
    const op = getHybridDebaterOp();
    const controller = new AbortController();
    const proposalSelf = defer<string>();
    const proposalPeer = defer<string>();
    const round1Self = defer<string>();
    const round1Peer = defer<string>();
    const round2Self = defer<string>();
    const round2Peer = defer<string>();
    const sendCalls: string[] = [];

    const input = makeInput({
      signal: controller.signal,
      proposalBarriers: [proposalSelf, proposalPeer],
      rebutBarriers: [
        [round1Self, round1Peer],
        [round2Self, round2Peer],
      ],
    });

    const hop = op.hopBody?.("ignored", {
      input,
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        return { output: `rebut-${sendCalls.length}` };
      }),
    });

    proposalSelf.resolve("proposal-0");
    proposalPeer.resolve("proposal-1");
    await Promise.resolve();

    controller.abort();
    round1Peer.resolve("round-1-peer");

    await expect(hop as Promise<{ readonly output: string }>).rejects.toBeInstanceOf(NaxError);
    await expect(hop as Promise<{ readonly output: string }>).rejects.toMatchObject({ code: "CALL_OP_ABORTED" });
    expect(sendCalls).toEqual(["round-1:proposal-0,proposal-1"]);
  });
});
