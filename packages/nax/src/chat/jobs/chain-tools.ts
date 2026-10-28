/** Repo-scoped chain proposals: validate the whole proposal before host approval. */
import type { ProviderTool, ToolResult } from "@nathapp/nax-agent";
import { buildChainStepArgv, CHAIN_STEP_FIELDS, type ChainStepInput, parseChainStepInput } from "./chain-argv";
import type { ChatChains } from "./chain-controller";
import { CHAIN_CHECK_MAX_LENGTH, CHAIN_MAX_STEPS, type ChainStep } from "./chain-types";
import type { ChatJobKind } from "./job-types";
import { resolvePlanSpec } from "./jobs-launch";
import type { JobsProviderOptions } from "./jobs-provider";

const BOT_PR_OFFSET = 2;

type Options = JobsProviderOptions & { readonly chains: ChatChains };
type InputError = { readonly error: string };
type ParsedStep = { readonly input: ChainStepInput; readonly checkBefore?: string };
export interface ResolvedChainProposal {
  readonly steps: readonly ChainStep[];
  readonly costCap?: number;
  readonly existingPlanPrds: readonly { readonly step: number; readonly feature: string }[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function launchKind(value: unknown): value is ChatJobKind {
  return typeof value === "string" && Object.hasOwn(CHAIN_STEP_FIELDS, value);
}
function stepError(step: number, message: string): InputError {
  return { error: `[chat] step ${step}: ${message.replace(/^\[chat\] /, "")}` };
}
function parseStep(raw: unknown, step: number): ParsedStep | InputError {
  if (!plainObject(raw) || !plainObject(raw.input)) return stepError(step, "input must be an object");
  if (!launchKind(raw.kind)) return stepError(step, `unknown kind ${String(raw.kind)}`);
  const input = parseChainStepInput(raw.kind, raw.input);
  if ("error" in input) return stepError(step, input.error);
  const { checkBefore } = raw;
  if (
    checkBefore !== undefined &&
    (typeof checkBefore !== "string" || checkBefore.length < 1 || checkBefore.length > CHAIN_CHECK_MAX_LENGTH)
  ) {
    return stepError(step, `checkBefore must be 1 to ${CHAIN_CHECK_MAX_LENGTH} characters`);
  }
  return { input, ...(checkBefore === undefined ? {} : { checkBefore }) };
}

async function resolveSteps(
  parsed: readonly ParsedStep[],
  options: Options,
): Promise<ResolvedChainProposal | InputError> {
  const steps: ChainStep[] = [];
  const existingPlanPrds: { step: number; feature: string }[] = [];
  for (const [index, entry] of parsed.entries()) {
    let { input } = entry;
    if (input.kind === "plan") {
      const resolved = await resolvePlanSpec(input.feature, input.spec, options);
      if ("error" in resolved) return stepError(index + 1, resolved.error);
      if (resolved.prdExists) existingPlanPrds.push({ step: index + 1, feature: input.feature });
      input = { ...input, spec: resolved.spec };
    }
    const argv = buildChainStepArgv(input, options);
    const prless = (input.kind === "bot_review" || input.kind === "bot_fix") && input.pr === undefined;
    // The bot PR token follows the two command tokens, independently of the entry length.
    steps.push({
      kind: input.kind,
      argv,
      target: "feature" in input ? input.feature : input.pr === undefined ? "" : String(input.pr),
      ...(prless ? { prIndex: options.naxEntry.length + BOT_PR_OFFSET } : {}),
      ...(entry.checkBefore === undefined ? {} : { checkBefore: entry.checkBefore }),
    });
  }
  return { steps, existingPlanPrds };
}

/** Keeps resolved argv and replacement metadata together for the chain card/activation boundary. */
export async function resolveChainProposal(
  raw: Record<string, unknown>,
  options: Options,
): Promise<ResolvedChainProposal | InputError> {
  const active = options.chains.active();
  if (active) return { error: `[chat] chain ${active.id} is already active; stop it with nax-jobs__chain_stop first` };
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > CHAIN_MAX_STEPS) {
    return { error: `[chat] a chain needs 1 to ${CHAIN_MAX_STEPS} steps` };
  }
  const { costCap } = raw;
  if (costCap !== undefined && (typeof costCap !== "number" || !Number.isFinite(costCap) || costCap <= 0)) {
    return { error: "[chat] costCap must be a positive number" };
  }
  const parsed: ParsedStep[] = [];
  for (const [index, rawStep] of raw.steps.entries()) {
    const step = parseStep(rawStep, index + 1);
    if ("error" in step) return step;
    parsed.push(step);
  }
  const resolved = await resolveSteps(parsed, options);
  if ("error" in resolved) return resolved;
  return { ...resolved, ...(costCap === undefined ? {} : { costCap }) };
}

function failure(content: string): ToolResult {
  return { isError: true, content };
}

export function createChainTools(options: JobsProviderOptions & { readonly chains: ChatChains }): ProviderTool[] {
  return [
    {
      localName: "chain",
      description: "Propose an ordered chain of billed nax steps for explicit user approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["steps"],
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              required: ["kind", "input"],
              additionalProperties: false,
              properties: { kind: { type: "string" }, input: { type: "object" }, checkBefore: { type: "string" } },
            },
          },
          costCap: { type: "number" },
        },
      },
      run: async (raw, ctx) => {
        const proposal = await resolveChainProposal(raw, options);
        if ("error" in proposal) return failure(proposal.error);
        const decision = await options.approve({
          tool: "nax-jobs__chain",
          summary: `full run of ${proposal.steps.length} steps`,
          reason: "Chain proposal validated; activation is not available yet.",
          command: proposal.steps.map((step) => step.argv.join(" ")).join("\n"),
          signal: ctx.signal,
        });
        // US-008 completes the card and activation; never grant autonomy in this placeholder.
        return failure(
          decision === "deny"
            ? "[chat] the user declined the chain; propose steps one at a time"
            : "[chat] chain activation is not available yet; nothing started",
        );
      },
    },
    {
      localName: "chain_check",
      description: "Record the verdict of a chain step's check.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["step", "passed", "note"],
        properties: { step: { type: "integer" }, passed: { type: "boolean" }, note: { type: "string" } },
      },
      run: async () => failure("[chat] chain_check is not available yet"),
    },
    {
      localName: "chain_stop",
      description: "Stop chain autonomy without cancelling running jobs.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] },
      run: async () => failure("[chat] chain_stop is not available yet"),
    },
  ];
}
