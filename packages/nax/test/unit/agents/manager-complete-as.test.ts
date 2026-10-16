import { describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { completeAsWithFallback } from "@/agents/manager-complete-as";
import type { AgentCompleteOutcome } from "@/agents/manager-types";
import type { CompleteOptions } from "@/agents/types";
import { NaxError } from "@/errors";
import { DispatchEventBus } from "@/runtime/dispatch-events";

describe("completeAsWithFallback", () => {
  test("returns the outcome and emits one dispatch event", async () => {
    const outcome: AgentCompleteOutcome = {
      result: { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
      fallbacks: [],
      dispatchesCompleted: 1,
    };
    const dispatchEvents = new DispatchEventBus();
    const emitDispatch = mock(dispatchEvents.emitDispatch.bind(dispatchEvents));
    const emitDispatchError = mock(dispatchEvents.emitDispatchError.bind(dispatchEvents));
    dispatchEvents.emitDispatch = emitDispatch;
    dispatchEvents.emitDispatchError = emitDispatchError;
    const input = {
      config: makeNaxConfig(),
      dispatchEvents,
      completeWithFallback: mock(async () => outcome),
    };
    const options: CompleteOptions = {
      workdir: "/tmp/test",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
    };

    await expect(completeAsWithFallback(input, "claude", "prompt", options)).resolves.toBe(outcome);
    expect(emitDispatch).toHaveBeenCalledTimes(1);
    expect(emitDispatchError).not.toHaveBeenCalled();
  });

  test("rethrows the same NaxError and emits one dispatch error", async () => {
    const error = new NaxError("completion failed", "AGENT_NOT_FOUND", { stage: "complete" });
    const dispatchEvents = new DispatchEventBus();
    const emitDispatch = mock(dispatchEvents.emitDispatch.bind(dispatchEvents));
    const emitDispatchError = mock(dispatchEvents.emitDispatchError.bind(dispatchEvents));
    dispatchEvents.emitDispatch = emitDispatch;
    dispatchEvents.emitDispatchError = emitDispatchError;
    const input = {
      config: makeNaxConfig(),
      dispatchEvents,
      completeWithFallback: mock(async () => {
        throw error;
      }),
    };
    const options: CompleteOptions = {
      workdir: "/tmp/test",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
    };

    await expect(completeAsWithFallback(input, "claude", "prompt", options)).rejects.toBe(error);
    expect(emitDispatch).not.toHaveBeenCalled();
    expect(emitDispatchError).toHaveBeenCalledTimes(1);
  });
});
