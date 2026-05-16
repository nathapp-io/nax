import { afterEach, describe, expect, mock, test } from "bun:test";
import { debateConfigSelector } from "@/config";
import * as operationsModule from "@/operations";

interface PromiseWithResolvers<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface PlanDebaterInput {
  readonly debater: { readonly agent: string; readonly model?: string };
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (peerProposals: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly rebuttalBarrier: PromiseWithResolvers<string>;
  readonly selectionSignal: Promise<{ readonly patchPrompt?: string }>;
  readonly signal: AbortSignal;
  readonly storyId: string;
}

interface PlanDebaterHopContext {
  readonly input: PlanDebaterInput;
  readonly send: (prompt: string) => Promise<{ readonly output: string }>;
}

interface PlanDebaterOp {
  readonly kind: "run";
  readonly name: string;
  readonly stage: string;
  readonly session: { readonly role: string; readonly lifetime: "fresh" | "warm" };
  readonly config: unknown;
  readonly model?: (input: PlanDebaterInput) => { readonly agent: string; readonly model: string };
  readonly hopBody?: (initialPrompt: string, ctx: PlanDebaterHopContext) => Promise<{ readonly output: string }>;
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

function getPlanDebaterOp(): PlanDebaterOp {
  const op = (operationsModule as Record<string, unknown>).planDebaterOp;
  expect(op).toBeDefined();
  return op as PlanDebaterOp;
}

function makeInput(overrides: Partial<PlanDebaterInput> = {}): PlanDebaterInput {
  const selfBarrier = defer<string>();
  const peerBarrier = defer<string>();
  const rebuttalBarrier = defer<string>();
  const selectionSignal = defer<{ readonly patchPrompt?: string }>();

  return {
    debater: { agent: "claude" },
    index: 0,
    proposePrompt: "## Propose\nWrite the plan.",
    buildRebutPrompt: (peerProposals: string[]) => `## Rebut\n${peerProposals.join(" | ")}`,
    proposalBarriers: [selfBarrier, peerBarrier],
    rebuttalBarrier,
    selectionSignal: selectionSignal.promise,
    signal: new AbortController().signal,
    storyId: "US-PLAN",
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

describe("planDebaterOp", () => {
  test("is exported from the operations barrel with the expected identity", () => {
    const op = getPlanDebaterOp();

    expect(op.kind).toBe("run");
    expect(op.name).toBe("debate-plan");
    expect(op.stage).toBe("plan");
    expect(op.session).toEqual({ role: "debate-plan", lifetime: "fresh" });
    expect(op.config).toBe(debateConfigSelector);
    expect(op.model?.(makeInput())).toEqual({ agent: "claude", model: "fast" });
  });

  test("resolves the rebuttal barrier before waiting on selection and patches when patchPrompt is provided", async () => {
    const op = getPlanDebaterOp();
    const input = makeInput();
    const proposalBarrier = input.proposalBarriers[0];
    const peerBarrier = input.proposalBarriers[1];
    const selectionBarrier = defer<{ readonly patchPrompt?: string }>();
    const sendCalls: string[] = [];

    const hop = op.hopBody?.(input.proposePrompt, {
      input: { ...input, selectionSignal: selectionBarrier.promise },
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        if (sendCalls.length === 1) return { output: "proposal-0" };
        if (sendCalls.length === 2) return { output: "rebut-0" };
        return { output: "patched-0" };
      }),
    });

    expect(hop).toBeDefined();
    await Promise.resolve();
    expect(sendCalls).toEqual([input.proposePrompt]);

    peerBarrier.resolve("peer-proposal");
    await expect(proposalBarrier.promise).resolves.toBe("proposal-0");
    await expect(input.rebuttalBarrier.promise).resolves.toBe("rebut-0");
    selectionBarrier.resolve({ patchPrompt: "## Patch\nApply the winner update." });

    await expect(hop as Promise<{ readonly output: string }>).resolves.toEqual({ output: "patched-0" });
    expect(sendCalls).toHaveLength(3);
    expect(sendCalls[2]).toBe("## Patch\nApply the winner update.");
  });

  test("returns the rebut turn when selection resolves with an empty object", async () => {
    const op = getPlanDebaterOp();
    const input = makeInput();
    const peerBarrier = input.proposalBarriers[1];
    const sendCalls: string[] = [];
    const selectionBarrier = defer<{ readonly patchPrompt?: string }>();
    const rebuttalBarrier = input.rebuttalBarrier;
    const hop = op.hopBody?.(input.proposePrompt, {
      input: { ...input, selectionSignal: selectionBarrier.promise },
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        if (sendCalls.length === 1) return { output: "proposal-0" };
        return { output: "rebut-0" };
      }),
    });

    expect(hop).toBeDefined();
    await Promise.resolve();
    peerBarrier.resolve("peer-proposal");
    await expect(rebuttalBarrier.promise).resolves.toBe("rebut-0");
    selectionBarrier.resolve({});

    await expect(hop as Promise<{ readonly output: string }>).resolves.toEqual({ output: "rebut-0" });
    expect(sendCalls).toHaveLength(2);
  });

  test("returns the rebut turn when selection resolves with an undefined patchPrompt", async () => {
    const op = getPlanDebaterOp();
    const input = makeInput();
    const peerBarrier = input.proposalBarriers[1];
    const sendCalls: string[] = [];
    const selectionBarrier = defer<{ readonly patchPrompt?: string }>();
    const rebuttalBarrier = input.rebuttalBarrier;
    const hop = op.hopBody?.(input.proposePrompt, {
      input: { ...input, selectionSignal: selectionBarrier.promise },
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        if (sendCalls.length === 1) return { output: "proposal-0" };
        return { output: "rebut-0" };
      }),
    });

    expect(hop).toBeDefined();
    await Promise.resolve();
    peerBarrier.resolve("peer-proposal");
    await expect(rebuttalBarrier.promise).resolves.toBe("rebut-0");
    selectionBarrier.resolve({ patchPrompt: undefined });

    await expect(hop as Promise<{ readonly output: string }>).resolves.toEqual({ output: "rebut-0" });
    expect(sendCalls).toHaveLength(2);
  });

  test("returns the rebut turn when the patch send fails", async () => {
    const op = getPlanDebaterOp();
    const input = makeInput();
    const peerBarrier = input.proposalBarriers[1];
    const selectionBarrier = defer<{ readonly patchPrompt?: string }>();
    const sendCalls: string[] = [];

    const hop = op.hopBody?.(input.proposePrompt, {
      input: { ...input, selectionSignal: selectionBarrier.promise },
      send: mock(async (prompt: string) => {
        sendCalls.push(prompt);
        if (sendCalls.length === 1) return { output: "proposal-0" };
        if (sendCalls.length === 2) return { output: "rebut-0" };
        throw new Error("patch failed");
      }),
    });

    expect(hop).toBeDefined();
    await Promise.resolve();
    peerBarrier.resolve("peer-proposal");
    await expect(input.rebuttalBarrier.promise).resolves.toBe("rebut-0");
    selectionBarrier.resolve({ patchPrompt: "## Patch\nApply the winner update." });

    await expect(hop as Promise<{ readonly output: string }>).resolves.toEqual({ output: "rebut-0" });
    expect(sendCalls).toHaveLength(3);
  });
});
