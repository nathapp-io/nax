import { debateConfigSelector } from "../config";
import type { DebateConfig } from "../config/selectors";
import type { FactsManifest } from "../debate/facts-manifest";
import { parseFactsManifest } from "../debate/facts-manifest";
import { NaxError } from "../errors";
import { GrounderPromptBuilder } from "../prompts";
import { parseLLMJson } from "../utils/llm-json";
import type { CompleteOperation } from "./types";

export interface GrounderInput {
  readonly specContent: string;
  readonly codebaseContext: string;
  readonly workdir: string;
}

export const groundOp: CompleteOperation<GrounderInput, FactsManifest, DebateConfig> = {
  kind: "complete",
  name: "ground",
  stage: "plan",
  jsonMode: true,
  config: debateConfigSelector,
  model: (_input, ctx) => ctx.config.debate?.grounder.model ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.debate?.grounder.timeoutSeconds ?? 300) * 1000,
  build(input, _ctx) {
    return new GrounderPromptBuilder().build(input.specContent, input.codebaseContext, input.workdir);
  },
  parse(output, _input, _ctx) {
    let raw: unknown;
    try {
      raw = parseLLMJson(output);
    } catch {
      throw new NaxError("Grounder output failed schema validation: not valid JSON", "GROUNDER_PARSE_FAILED", {});
    }
    const result = parseFactsManifest(raw);
    if (!result.ok) {
      throw new NaxError(`Grounder output failed schema validation: ${result.error}`, "GROUNDER_PARSE_FAILED", {});
    }
    return result.manifest;
  },
};
