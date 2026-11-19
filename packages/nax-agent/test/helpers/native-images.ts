import type { ClientRequest, CompleteResult, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { withDerivedStream } from "./stream-from-complete";

/** One scripted round trip: what the model answers, and why it stopped. */
export interface ScriptedTurn {
  readonly text: string;
  readonly toolCalls?: NonNullable<CompleteResult["toolCalls"]>;
  readonly stopReason?: CompleteResult["stopReason"];
}

/** Records `complete()` requests and replays `turns` in order (the last one repeats). */
function installRecordingClient(input: readonly ("text" | "image")[] | undefined, turns: readonly ScriptedTurn[]) {
  const originalBuild = _clientDeps.build;
  const requests: ClientRequest[] = [];
  const modelCalls: string[][] = [];
  const resolved: ResolvedModel = {
    id: "stub-model",
    provider: "stub",
    protocol: "stub",
    pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    supportsTools: true,
    thinkingLevels: [],
    ...(input !== undefined ? { input } : {}),
  };
  _resetNativeClient();
  _clientDeps.build = async () =>
    withDerivedStream({
      model: async (provider, model) => {
        modelCalls.push([provider, model]);
        return resolved;
      },
      listModels: async () => [resolved],
      pricing: () => resolved.pricing,
      stream: async function* stream() {},
      complete: async (model, request) => {
        if (model !== resolved) throw new Error("expected the resolved model");
        requests.push({ ...request, messages: structuredClone(request.messages) });
        const turn = turns[Math.min(requests.length - 1, turns.length - 1)] ?? { text: "ok" };
        const stopReason = turn.stopReason ?? (turn.toolCalls === undefined ? "stop" : "tool_use");
        return {
          text: turn.text,
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason,
          ...(turn.toolCalls !== undefined ? { toolCalls: turn.toolCalls } : {}),
        };
      },
      validate: () => {},
    });
  return {
    requests,
    modelCalls,
    restore() {
      _clientDeps.build = originalBuild;
      _resetNativeClient();
    },
  };
}

/** Record complete() requests while exercising the production streamComplete route. */
export function installImageClient(input?: readonly ("text" | "image")[]) {
  return installRecordingClient(input, [{ text: "ok" }]);
}

/**
 * The same recording client, scripted with several round trips, for a turn
 * that calls a tool and then answers (US-002). The request each round trip
 * sent is what a test reads to see what reached the model.
 */
export function installTurnClient(turns: readonly ScriptedTurn[], input?: readonly ("text" | "image")[]) {
  return installRecordingClient(input, turns);
}
