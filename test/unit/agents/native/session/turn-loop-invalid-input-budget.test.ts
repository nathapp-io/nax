/**
 * Hard budget for repeated invalid calls (nax#2047, Task 4).
 *
 * A malformed tool call is never productive. The spin breaker's 50-call budget
 * is for REPEATED valid-shape calls; a malformed shape is a stronger signal —
 * the model will keep sending the same wrong shape for as long as it ignores
 * the error result. The gate this task adds hard-stops a turn after 3 identical
 * invalid calls (same tool, same `stableStringify`'d input) so the transcript
 * never grows past the second error result.
 *
 * Mirrors the mkdtemp + nativeTranscriptDirs + loadTranscript pattern of
 * `turn-loop-invalid-input.test.ts` (Task 3) and `turn-loop-spin.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterInteraction } from "@/agents/interaction-handler";
import { nativeTranscriptDirs } from "@/agents/native/session/session";
import { loadTranscript } from "@/agents/native/session/transcript-store";
import { runNativeTurn } from "@/agents/native/session/turn-loop";
import type { TurnDeps } from "@/agents/native/session/turn-types";
import type { SendTurnOpts } from "@/agents/session-types";
import type { CodingTool } from "@/tools";

// Live defect shape (see Task 3 test file): the RunCommand schema demands
// `values` be an object. The malformed input is `values:""`.
const RUN_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["testScoped", "typecheck"] },
    values: { type: "object" },
  },
} as const;

const MALFORMED_A = { command: "testScoped", values: "" } as const;
// Same tool, different property violation. Each is invalid but the key
// (name + stableStringify(input)) differs, so the per-key counter stays at 1.
const MALFORMED_B = { command: "BAD", values: { any: "thing" } } as const;
const MALFORMED_C = { command: 42, values: { any: "thing" } } as const;

const VALID_INPUT = { command: "typecheck" };

let dir: string;
const handle = { id: "sess-invalid-input-budget", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-invalid-input-budget-"));
  nativeTranscriptDirs.set("sess-invalid-input-budget", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-invalid-input-budget");
  await rm(dir, { recursive: true, force: true });
});

const fakeRunCommand: CodingTool = {
  name: "RunCommand",
  description: "Run a declared command",
  inputSchema: RUN_COMMAND_SCHEMA,
  scope: {
    pathFields: [],
    listPathFields: ["values.files"],
    verbField: "command",
    allowedVerbs: ["testScoped", "typecheck"],
  },
  async run() {
    return { content: "ok" };
  },
};

const baseOpts = (over: Partial<SendTurnOpts> = {}): SendTurnOpts => ({
  interactionHandler: {
    onInteraction: async () => ({ answer: "29 tests passed" }),
  },
  codingTools: [fakeRunCommand],
  ...over,
});

const baseUsage = { inputTokens: 1, outputTokens: 1 };

type RoundTripPlan = ReadonlyArray<{
  text: string;
  toolCalls?: ReadonlyArray<{ id: string; input: Record<string, unknown> }>;
}>;

interface DrivingComplete {
  first: TurnDeps["complete"];
  observedInputs: unknown[];
}

function drivingComplete(plan: RoundTripPlan): DrivingComplete {
  const observed: unknown[] = [];
  let call = 0;
  const complete: TurnDeps["complete"] = async () => {
    const step = plan[call] ?? { text: "done" };
    call += 1;
    return {
      text: step.text,
      toolCalls: step.toolCalls?.map((c) => ({ id: c.id, name: "RunCommand", input: c.input })),
      usage: baseUsage,
      costUsd: 0,
    };
  };
  return { first: complete, observedInputs: observed };
}

async function runTurn(driving: DrivingComplete): Promise<{
  result: Awaited<ReturnType<typeof runNativeTurn>>;
  saved: Awaited<ReturnType<typeof loadTranscript>>;
}> {
  const observed = driving.observedInputs;
  const opts = baseOpts({
    interactionHandler: {
      onInteraction: async (req: AdapterInteraction) => {
        if (req.kind === "coding-tool") observed.push(req.input);
        return { answer: "29 tests passed" };
      },
    },
  });
  const result = await runNativeTurn(handle, "hi", opts, { complete: driving.first });
  const saved = await loadTranscript(dir, handle.id);
  return { result, saved };
}

function countToolResults(saved: Awaited<ReturnType<typeof loadTranscript>>): number {
  return saved.filter((m) => m.role === "tool-result").length;
}

describe("runNativeTurn — invalid call budget (nax#2047)", () => {
  test("1. 3 identical invalid calls end the turn with invalidCallBudgetExceeded", async () => {
    // Same shape, same key — three round trips, one malformed call each.
    const driving = drivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_A } }] },
      // Should never be reached — the 3rd invalid call trips the budget and
      // the loop ends before round-trip 4. If the implementation doesn't
      // stop, this clean text becomes the wrap-up.
      { text: "done" },
    ]);
    const { result, saved } = await runTurn(driving);

    expect(result.invalidCallBudgetExceeded).toBe(true);
    // Distinguishable from a spin-stopped turn — that's a separate channel.
    expect(result.spinStopped).toBeFalsy();
    // The model asked for work the loop never executed.
    expect(result.turnIncomplete).toBe(true);
    // No valid tool calls reached the interaction handler.
    expect(driving.observedInputs).toEqual([]);
    // The 3rd invalid call was NOT answered with a tool-result. Only the
    // first two rewrites appended an error result.
    expect(countToolResults(saved)).toBe(2);
  });

  test("2. the 3rd identical invalid call has no tool-result in the saved transcript", async () => {
    const driving = drivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_A } }] },
      { text: "done" },
    ]);
    const { saved } = await runTurn(driving);

    // Belt-and-braces: every saved tool-result belongs to one of the first
    // two invalid calls. The third call's id never appears in a tool-result.
    const toolResults = saved.filter((m) => m.role === "tool-result");
    const ids = toolResults.map((m) => (m.role === "tool-result" ? m.toolCallId : ""));
    expect(ids).not.toContain("c3");
    expect(toolResults.length).toBe(2);

    // The assistant message for round-trip 3 IS persisted (the model said
    // something), but with no answering tool-result — exactly the shape the
    // brief calls out as "a result nobody reads only grows the transcript".
    const assistants = saved.filter((m) => m.role === "assistant");
    const lastAssistant = assistants[assistants.length - 1];
    expect(lastAssistant).toBeDefined();
    if (lastAssistant === undefined || lastAssistant.role !== "assistant") throw new Error("unreachable");
    const lastToolCall = lastAssistant.toolCalls?.[0];
    expect(lastToolCall?.id).toBe("c3");
  });

  test("3. TurnResult is distinguishable from fail-spin (invalidCallBudgetExceeded, not spinStopped)", async () => {
    const driving = drivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_A } }] },
      { text: "done" },
    ]);
    const { result } = await runTurn(driving);

    expect(result.invalidCallBudgetExceeded).toBe(true);
    expect(result.spinStopped).toBeUndefined();
  });

  test("4. 3 invalid calls with DIFFERENT inputs do NOT stop — the model is exploring", async () => {
    // Each call has a distinct key (different stableStringify'd input), so
    // every counter stays at 1. The budget is per-key, not per-turn.
    const driving = drivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_B } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_C } }] },
      { text: "done" },
    ]);
    const { result, saved } = await runTurn(driving);

    expect(result.invalidCallBudgetExceeded).toBeUndefined();
    expect(result.spinStopped).toBeFalsy();
    // Loop ran through to the model's clean-text exit — the turn completed.
    expect(result.turnIncomplete).toBeFalsy();
    expect(result.output).toBe("done");
    // All three invalid calls were rewritten, none reached the handler.
    expect(driving.observedInputs).toEqual([]);
    // Each invalid call appends one error tool-result.
    expect(countToolResults(saved)).toBe(3);
  });

  test("5. counter is cumulative — 2 invalid + 1 valid + 1 invalid trips on the 4th invalid", async () => {
    // Same key A appears three times total, but interleaved with a valid call.
    // The brief is explicit: cumulative, not consecutive — a valid call does
    // not reset the counter, and a later reappearance of A keeps accumulating.
    const driving = drivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] }, // counter[A]=1
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] }, // counter[A]=2
      { text: "", toolCalls: [{ id: "c3", input: { ...VALID_INPUT } }] }, // valid — handler runs
      { text: "", toolCalls: [{ id: "c4", input: { ...MALFORMED_A } }] }, // counter[A]=3 → STOP
      { text: "done" },
    ]);
    const { result, saved } = await runTurn(driving);

    expect(result.invalidCallBudgetExceeded).toBe(true);
    // The valid call reached the handler — observed in input order.
    expect(driving.observedInputs).toEqual([VALID_INPUT]);
    // Two error results (c1, c2) plus one success result (c3). c4 is NOT
    // answered — the budget tripped on the 4th invalid call and no
    // tool-result is appended.
    expect(countToolResults(saved)).toBe(3);
    const toolResults = saved.filter((m) => m.role === "tool-result");
    const ids = toolResults.map((m) => (m.role === "tool-result" ? m.toolCallId : ""));
    expect(ids).not.toContain("c4");
    const c4Ids = toolResults.filter((m) => m.role === "tool-result" && m.toolCallId === "c4");
    expect(c4Ids.length).toBe(0);
  });
});
