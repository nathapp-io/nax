import type { ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { withDerivedStream } from "./stream-from-complete";

/** Record complete() requests while exercising the production streamComplete route. */
export function installImageClient(input?: readonly ("text" | "image")[]) {
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
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
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
