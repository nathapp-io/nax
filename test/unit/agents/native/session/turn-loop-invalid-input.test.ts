/**
 * RunCommand's live defect shape (nax#2047): the model passed `values:""` and
 * the loop kept executing it. The validator + exemplar rewrite this input into
 * a schema-conforming one before any of it reaches `interactionHandler`.
 *
 * These tests drive `runNativeTurn` end to end so the rewrite is observed on
 * the actual persisted transcript — the same artifact the next round trip
 * would read back. Mirrors `turn-loop-spin.test.ts` (mkdtemp + nativeTranscriptDirs
 * + loadTranscript), since the failure mode is the same shape: a `complete` stub
 * whose first call returns a tool call, second returns clean text so the loop exits.
 *
 * Also pins the hard budget for repeated invalid calls (nax#2047, Task 4). A
 * malformed tool call is never productive. The spin breaker's 50-call budget
 * is for REPEATED valid-shape calls; a malformed shape is a stronger signal —
 * the model will keep sending the same wrong shape for as long as it ignores
 * the error result. The gate hard-stops a turn after 3 identical invalid calls
 * (same tool, same `stableStringify`'d input) so the transcript never grows
 * past the second error result.
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

// Schema shape copied from src/tools/run-command.ts:270-292 — the live defect
// was values expected object, model returned values:"". We do not depend on
// the real createRunCommandTool here because it pulls in policy/runtime; the
// validator only needs properties.{command,values} for this contract.
const RUN_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["testScoped", "typecheck"] },
    values: { type: "object" },
  },
} as const;

const MALFORMED = { command: "testScoped", values: "" } as const;
// exemplarFor produces this for `{ command: "testScoped", values: "" }` against
// the schema above (no declared properties on `values`, so the fallback shape
// `{ "<FILL IN>": "<FILL IN>" }` applies — see tool-input-exemplar.test.ts).
const EXEMPLAR = { command: "testScoped", values: { "<FILL IN>": "<FILL IN>" } } as const;

// Same tool, different property violations. Each is invalid but the key
// (name + stableStringify(input)) differs, so the per-key counter stays at 1.
const MALFORMED_A = { command: "testScoped", values: "" } as const;
const MALFORMED_B = { command: "BAD", values: { any: "thing" } } as const;
const MALFORMED_C = { command: 42, values: { any: "thing" } } as const;

const VALID_INPUT = { command: "typecheck" };

let dir: string;
let budgetDir: string;
const handle = { id: "sess-invalid-input", agentName: "native" } as const;
const budgetHandle = { id: "sess-invalid-input-budget", agentName: "native" } as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-turn-invalid-input-"));
  nativeTranscriptDirs.set("sess-invalid-input", dir);
});
afterEach(async () => {
  nativeTranscriptDirs.delete("sess-invalid-input");
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
    onInteraction: async () => ({ answer: "ok" }),
  },
  codingTools: [fakeRunCommand],
  ...over,
});

const baseUsage = { inputTokens: 1, outputTokens: 1 };

interface DrivingComplete {
  first: TurnDeps["complete"];
  /** Records every coding-tool interaction observed by the stub handler. */
  observedInputs?: unknown[];
}

function drivingComplete(
  firstToolCalls: ReadonlyArray<{ id: string; input: Record<string, unknown> }>,
): DrivingComplete {
  const observed: unknown[] = [];
  let roundTrip = 0;
  const complete: TurnDeps["complete"] = async () => {
    roundTrip += 1;
    if (roundTrip === 1) {
      return {
        text: "",
        toolCalls: firstToolCalls.map((c) => ({ id: c.id, name: "RunCommand", input: c.input })),
        usage: baseUsage,
        costUsd: 0,
      };
    }
    // Second round trip: clean text answer so the loop exits normally.
    return { text: "done", usage: baseUsage, costUsd: 0 };
  };
  return { first: complete, observedInputs: observed };
}

async function runTurn(
  driving: DrivingComplete,
  optsOverrides: Partial<SendTurnOpts> = {},
): Promise<{ saved: Awaited<ReturnType<typeof loadTranscript>> }> {
  const observed = driving.observedInputs ?? [];
  const opts = baseOpts({
    ...optsOverrides,
    interactionHandler: {
      onInteraction: async (req: AdapterInteraction) => {
        if (req.kind === "coding-tool") observed.push(req.input);
        return { answer: "29 tests passed" };
      },
    },
  });
  await runNativeTurn(handle, "hi", opts, { complete: driving.first });
  const saved = await loadTranscript(dir, handle.id);
  return { saved };
}

describe("runNativeTurn — invalid tool call input (nax#2047)", () => {
  test("1. invalid call: interactionHandler.onInteraction is never called for it", async () => {
    let onInteractionCalls = 0;
    let roundTrip = 0;
    const opts = baseOpts({
      interactionHandler: {
        onInteraction: async () => {
          onInteractionCalls += 1;
          throw new Error("interactionHandler.onInteraction should NOT be called for an invalid tool call");
        },
      },
    });
    await runNativeTurn(handle, "hi", opts, {
      complete: async () => {
        roundTrip += 1;
        if (roundTrip > 1) return { text: "done", usage: baseUsage, costUsd: 0 };
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "RunCommand", input: { ...MALFORMED } }],
          usage: baseUsage,
          costUsd: 0,
        };
      },
    });
    // Round-trip 1 emits the malformed call; the gate short-circuits before
    // onInteraction and appends an error tool-result, so round-trip 2 sees a
    // clean text answer and exits. onInteraction must never have been called.
    expect(onInteractionCalls).toBe(0);
  });

  test("2. invalid call: transcript persists the exemplar, not the malformed input", async () => {
    const driving = drivingComplete([{ id: "c1", input: { ...MALFORMED } }]);
    const { saved } = await runTurn(driving);

    const assistantWithCall = saved.find(
      (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length === 1,
    );
    expect(assistantWithCall).toBeDefined();
    if (assistantWithCall === undefined || assistantWithCall.role !== "assistant") throw new Error("unreachable");
    expect(assistantWithCall.toolCalls).toBeDefined();
    if (assistantWithCall.toolCalls === undefined) throw new Error("unreachable");
    expect(assistantWithCall.toolCalls[0]?.input).toEqual(EXEMPLAR);

    // Belt-and-braces: the raw malformed byte sequence is nowhere in the
    // persisted JSON. The error message text legitimately mentions "values"
    // and the exemplar, but never the literal `{"values":""}` shape.
    const serialized = JSON.stringify(saved);
    expect(serialized).not.toContain('{"values":""}');
  });

  test("3. invalid call: a tool-result with matching toolCallId, isError:true, and a message naming property and exemplar", async () => {
    const driving = drivingComplete([{ id: "c1", input: { ...MALFORMED } }]);
    const { saved } = await runTurn(driving);

    const toolResults = saved.filter((m) => m.role === "tool-result");
    const errorResult = toolResults.find((m) => m.role === "tool-result" && m.isError === true);
    expect(errorResult).toBeDefined();
    if (errorResult === undefined || errorResult.role !== "tool-result") throw new Error("unreachable");
    expect(errorResult.toolCallId).toBe("c1");
    expect(errorResult.content).toContain("values");
    expect(errorResult.content).toContain("<FILL IN>");
    // Exactly one tool-result per invalid call (the loop's continue, no second error).
    expect(toolResults.length).toBe(1);
  });

  test("4. invalid call: thinking block is byte-identical after the rewrite", async () => {
    const thinking = [{ text: "let me think", signature: "sig-1" }];
    let roundTrip = 0;
    const driving: DrivingComplete = {
      first: async () => {
        roundTrip += 1;
        if (roundTrip > 1) return { text: "done", usage: baseUsage, costUsd: 0 };
        return {
          text: "",
          thinking,
          toolCalls: [{ id: "c1", name: "RunCommand", input: { ...MALFORMED } }],
          usage: baseUsage,
          costUsd: 0,
        };
      },
    };
    const { saved } = await runTurn(driving);

    const assistant = saved.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    if (assistant === undefined || assistant.role !== "assistant") throw new Error("unreachable");
    // Deep equality — byte-for-byte. The same object reference is acceptable,
    // but deep equal is the contract: a fresh array with the same shape is
    // also fine and what the implementation produces.
    expect(assistant.thinking).toEqual(thinking);
    // Strictly: the assistant's rewritten toolCalls entry is the exemplar.
    expect(assistant.toolCalls?.[0]?.input).toEqual(EXEMPLAR);
  });

  test("5. sibling calls: valid call executes via onInteraction; invalid call is rewritten only", async () => {
    const driving = drivingComplete([
      { id: "c1", input: { command: "testScoped", values: "" } }, // invalid (values:"")
      { id: "c2", input: { command: "typecheck" } }, // valid (values absent)
    ]);
    const { saved } = await runTurn(driving);

    // c2 reached the interaction handler with byte-identical input.
    expect(driving.observedInputs).toEqual([{ command: "typecheck" }]);

    const assistant = saved.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    if (assistant === undefined || assistant.role !== "assistant" || assistant.toolCalls === undefined) {
      throw new Error("unreachable");
    }
    const byId = new Map(assistant.toolCalls.map((c) => [c.id, c]));
    expect(byId.get("c1")?.input).toEqual(EXEMPLAR);
    expect(byId.get("c2")?.input).toEqual({ command: "typecheck" });

    // Exactly one tool-result: the error for c1. c2 ran through onInteraction
    // and produced a real tool-result too — but that flows through the normal
    // path, not the invalid-call gate, so it appears after c1's error result.
    const toolResults = saved.filter((m) => m.role === "tool-result");
    expect(toolResults.length).toBe(2);
    const errorForC1 = toolResults.find((m) => m.role === "tool-result" && m.toolCallId === "c1" && m.isError === true);
    const resultForC2 = toolResults.find(
      (m) => m.role === "tool-result" && m.toolCallId === "c2" && m.isError !== true,
    );
    expect(errorForC1).toBeDefined();
    expect(resultForC2).toBeDefined();
  });

  test("6. two invalid calls in one assistant message: both are rewritten (second composes onto first)", async () => {
    const driving = drivingComplete([
      { id: "c1", input: { command: "testScoped", values: "" } },
      { id: "c2", input: { command: "typecheck", values: "" } },
    ]);
    const { saved } = await runTurn(driving);

    // Neither reaches the interaction handler.
    expect(driving.observedInputs).toEqual([]);

    const assistant = saved.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    if (assistant === undefined || assistant.role !== "assistant" || assistant.toolCalls === undefined) {
      throw new Error("unreachable");
    }
    const byId = new Map(assistant.toolCalls.map((c) => [c.id, c]));
    // Both calls' `values` were the empty string — the validator must catch
    // both, and the rewrite must compose onto the result of the first rewrite
    // (NOT onto the original message). A naive implementation that re-reads
    // the original assistant message each iteration would leave c1's input as
    // `{ values: "" }` and only rewrite c2.
    expect(byId.get("c1")?.input).toEqual({ command: "testScoped", values: { "<FILL IN>": "<FILL IN>" } });
    expect(byId.get("c2")?.input).toEqual({ command: "typecheck", values: { "<FILL IN>": "<FILL IN>" } });

    // Both produce tool-results, both error.
    const toolResults = saved.filter((m) => m.role === "tool-result");
    expect(toolResults.length).toBe(2);
    expect(toolResults.every((m) => m.role === "tool-result" && m.isError === true)).toBe(true);
  });

  test("7. valid call: onInteraction receives the original input byte-identical", async () => {
    const validInput = { command: "typecheck" };
    const driving = drivingComplete([{ id: "c1", input: validInput }]);
    const { saved } = await runTurn(driving);

    expect(driving.observedInputs).toEqual([validInput]);

    // Assistant message keeps the original input — no rewrite on the happy path.
    const assistant = saved.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    if (assistant === undefined || assistant.role !== "assistant" || assistant.toolCalls === undefined) {
      throw new Error("unreachable");
    }
    expect(assistant.toolCalls[0]?.input).toEqual(validInput);

    // One tool-result, not an error.
    const toolResults = saved.filter((m) => m.role === "tool-result");
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]?.isError).not.toBe(true);
  });
});

type RoundTripPlan = ReadonlyArray<{
  text: string;
  toolCalls?: ReadonlyArray<{ id: string; input: Record<string, unknown> }>;
}>;

interface BudgetDrivingComplete {
  first: TurnDeps["complete"];
  observedInputs: unknown[];
}

function budgetDrivingComplete(plan: RoundTripPlan): BudgetDrivingComplete {
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

describe("runNativeTurn — invalid call budget (nax#2047)", () => {
  beforeEach(async () => {
    budgetDir = await mkdtemp(join(tmpdir(), "nax-turn-invalid-input-budget-"));
    nativeTranscriptDirs.set("sess-invalid-input-budget", budgetDir);
  });
  afterEach(async () => {
    nativeTranscriptDirs.delete("sess-invalid-input-budget");
    await rm(budgetDir, { recursive: true, force: true });
  });

  async function runBudgetTurn(driving: BudgetDrivingComplete): Promise<{
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
    const result = await runNativeTurn(budgetHandle, "hi", opts, { complete: driving.first });
    const saved = await loadTranscript(budgetDir, budgetHandle.id);
    return { result, saved };
  }

  function countToolResults(saved: Awaited<ReturnType<typeof loadTranscript>>): number {
    return saved.filter((m) => m.role === "tool-result").length;
  }

  test("1. 3 identical invalid calls end the turn with invalidCallBudgetExceeded", async () => {
    // Same shape, same key — three round trips, one malformed call each.
    const driving = budgetDrivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_A } }] },
      // Should never be reached — the 3rd invalid call trips the budget and
      // the loop ends before round-trip 4. If the implementation doesn't
      // stop, this clean text becomes the wrap-up.
      { text: "done" },
    ]);
    const { result, saved } = await runBudgetTurn(driving);

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
    const driving = budgetDrivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_A } }] },
      { text: "done" },
    ]);
    const { saved } = await runBudgetTurn(driving);

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
    const driving = budgetDrivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_A } }] },
      { text: "done" },
    ]);
    const { result } = await runBudgetTurn(driving);

    expect(result.invalidCallBudgetExceeded).toBe(true);
    expect(result.spinStopped).toBeUndefined();
  });

  test("4. 3 invalid calls with DIFFERENT inputs do NOT stop — the model is exploring", async () => {
    // Each call has a distinct key (different stableStringify'd input), so
    // every counter stays at 1. The budget is per-key, not per-turn.
    const driving = budgetDrivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] },
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_B } }] },
      { text: "", toolCalls: [{ id: "c3", input: { ...MALFORMED_C } }] },
      { text: "done" },
    ]);
    const { result, saved } = await runBudgetTurn(driving);

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
    const driving = budgetDrivingComplete([
      { text: "", toolCalls: [{ id: "c1", input: { ...MALFORMED_A } }] }, // counter[A]=1
      { text: "", toolCalls: [{ id: "c2", input: { ...MALFORMED_A } }] }, // counter[A]=2
      { text: "", toolCalls: [{ id: "c3", input: { ...VALID_INPUT } }] }, // valid — handler runs
      { text: "", toolCalls: [{ id: "c4", input: { ...MALFORMED_A } }] }, // counter[A]=3 → STOP
      { text: "done" },
    ]);
    const { result, saved } = await runBudgetTurn(driving);

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
