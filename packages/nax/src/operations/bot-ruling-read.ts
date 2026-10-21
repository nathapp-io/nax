import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { buildBotRulingReadPrompt } from "@/prompts";
import { tryParseLLMJson } from "@/utils/llm-json";
import type { CompleteOperation } from "./types";

export type RulingDisposition = "fixed" | "waived" | "confirmed" | "overridden" | "verified" | "none";
export interface BotRulingReadInput {
  readonly items: readonly {
    readonly id: string;
    readonly kind: string;
    readonly issue: string;
    readonly reply: { readonly id: string; readonly author: string; readonly body: string };
  }[];
  readonly model?: ConfiguredModel;
}
export interface BotRulingReadVerdict {
  readonly rulings: readonly {
    readonly id: string;
    readonly disposition: RulingDisposition;
    readonly reason: string;
    readonly quote: string;
    readonly sha?: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isDisposition(value: unknown): value is RulingDisposition {
  return (
    value === "fixed" ||
    value === "waived" ||
    value === "confirmed" ||
    value === "overridden" ||
    value === "verified" ||
    value === "none"
  );
}

function parseRulings(output: string, input: BotRulingReadInput): BotRulingReadVerdict | null {
  const raw = tryParseLLMJson<unknown>(output);
  if (!isRecord(raw) || !Array.isArray(raw.rulings)) return null;
  const ids = new Set(input.items.map((item) => item.id));
  const rulings: BotRulingReadVerdict["rulings"][number][] = [];
  const seen = new Set<string>();
  for (const entry of raw.rulings) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !ids.has(entry.id) || !isDisposition(entry.disposition))
      continue;
    if (typeof entry.reason !== "string" || typeof entry.quote !== "string") continue;
    if (entry.sha !== undefined && typeof entry.sha !== "string") continue;
    if (seen.has(entry.id)) return null; // Ambiguous duplicate ids fail closed.
    seen.add(entry.id);
    rulings.push({
      id: entry.id,
      disposition: entry.disposition,
      reason: entry.reason,
      quote: entry.quote,
      ...(entry.sha !== undefined ? { sha: entry.sha } : {}),
    });
  }
  return { rulings };
}

export const botRulingReadOp: CompleteOperation<BotRulingReadInput, BotRulingReadVerdict | null, WorkflowOpConfig> = {
  kind: "complete",
  name: "bot-ruling-read",
  stage: "review",
  config: workflowConfigSelector,
  model: (input) => input.model ?? "fast",
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildBotRulingReadPrompt(input), overridable: false },
  }),
  parse: parseRulings,
};
