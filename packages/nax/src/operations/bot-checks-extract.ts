import type { ConfiguredModel } from "@/config";
import { workflowConfigSelector } from "@/config";
import type { WorkflowOpConfig } from "@/config/selectors";
import { buildBotChecksExtractPrompt } from "@/prompts";
import { tryParseLLMJson } from "@/utils/llm-json";
import type { CompleteOperation } from "./types";

export interface BotChecksExtractInput {
  readonly fileName: "AGENTS.md" | "CLAUDE.md";
  readonly text: string;
  readonly model?: ConfiguredModel;
}

export interface BotChecksExtractOutput {
  readonly gates: readonly {
    readonly gate: "build" | "typecheck" | "lint" | "test";
    readonly command: string;
  }[];
  readonly install?: string;
}

type Gate = BotChecksExtractOutput["gates"][number]["gate"];
const MAX_COMMAND_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGate(value: unknown): value is Gate {
  return value === "build" || value === "typecheck" || value === "lint" || value === "test";
}

function parseCommand(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\n\r\0]/.test(value)) return undefined;
  const command = value.trim();
  return command.length > 0 && command.length <= MAX_COMMAND_LENGTH ? command : undefined;
}

export function parseBotChecksReply(output: string): BotChecksExtractOutput | null {
  const raw = tryParseLLMJson<unknown>(output);
  if (!isRecord(raw) || !Array.isArray(raw.gates)) return null;
  const gates: { gate: Gate; command: string }[] = [];
  const seen = new Set<Gate>();
  for (const entry of raw.gates) {
    if (!isRecord(entry) || !isGate(entry.gate) || seen.has(entry.gate)) continue;
    const command = parseCommand(entry.command);
    if (command === undefined) continue;
    seen.add(entry.gate);
    gates.push({ gate: entry.gate, command });
  }
  const install = parseCommand(raw.install);
  return { gates, ...(install !== undefined ? { install } : {}) };
}

export const botChecksExtractOp: CompleteOperation<
  BotChecksExtractInput,
  BotChecksExtractOutput | null,
  WorkflowOpConfig
> = {
  kind: "complete",
  name: "bot-checks-extract",
  stage: "review",
  config: workflowConfigSelector,
  model: (input) => input.model ?? "fast",
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildBotChecksExtractPrompt(input), overridable: false },
  }),
  parse: parseBotChecksReply,
};
