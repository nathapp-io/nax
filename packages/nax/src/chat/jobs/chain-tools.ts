/** Repo-scoped chain proposals: validate the whole proposal before host approval. */
import type { ProviderTool, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { buildChainStepArgv, CHAIN_STEP_FIELDS, type ChainStepInput, parseChainStepInput } from "./chain-argv";
import type { ChatChains } from "./chain-controller";
import { CHAIN_CHECK_MAX_LENGTH, CHAIN_MAX_STEPS, type ChainStep } from "./chain-types";
import type { ChatJobKind } from "./job-types";
import { _jobsLaunchDeps, resolvePlanSpec } from "./jobs-launch";
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

function stepLabel(step: ChainStep): string {
  if (step.kind === "plan" || step.kind === "run") return `nax ${step.kind} ${step.target}`;
  const action = step.kind === "bot_review" ? "review" : "fix";
  return `nax bot ${action} ${step.prIndex === undefined ? `#${step.target}` : "(PR chosen by the agent)"}`;
}

function stepReason(step: ChainStep, index: number): string {
  const condition = index === 0 ? "you approve this card" : `step ${index} succeeded`;
  const check = step.checkBefore === undefined ? "" : ` and check "${step.checkBefore}" passed`;
  const pr = step.prIndex === undefined ? "" : " — the agent picks the PR when the step starts";
  return `${index + 1}. ${stepLabel(step)} — starts after: ${condition}${check}${pr}`;
}

async function chainReason(proposal: ResolvedChainProposal, options: Options): Promise<string> {
  const branch = await _jobsLaunchDeps.git(["symbolic-ref", "--short", "HEAD"], options.repoRoot);
  return [
    `workdir ${options.repoRoot}${branch.exitCode === 0 ? ` on branch ${branch.stdout.trim()}` : ""}`,
    `nax ${options.naxEntry.join(" ")}`,
    ...proposal.steps.map(stepReason),
    proposal.costCap === undefined
      ? "no cost cap"
      : `cost cap $${proposal.costCap.toFixed(2)}, checked between steps; plan and bot job costs are not counted`,
    ...proposal.existingPlanPrds.map(
      ({ step, feature }) => `warning: step ${step} replaces the existing prd.json for ${feature}`,
    ),
    ...(options.interactionPlugin === "cli" && proposal.steps.some((step) => step.kind === "run")
      ? ["warning: run steps have no channel for their own asks; they will time out"]
      : []),
    "Steps run in this order, each once. A failed step or check, a different step, the cost cap, a cancel or closing the chat stops the chain.",
  ].join("\n");
}

async function activateProposal(proposal: ResolvedChainProposal, options: Options): Promise<ToolResult> {
  try {
    const chain = await options.chains.activate({ steps: proposal.steps, costCap: proposal.costCap });
    return {
      content: `${JSON.stringify({ chain: chain.id, state: "active", next: 1 })}\nCall step 1 now with exactly the approved arguments.`,
    };
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "CHAT_CHAIN_ACTIVE") {
      return failure("[chat] another chain became active while this card was open; this one is not active");
    }
    return failure(`[chat] could not save the chain: ${errorMessage(cause)}; it is not active`);
  }
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
          summary: `full run of ${proposal.steps.length} steps: ${proposal.steps.map(stepLabel).join(" → ")}`,
          reason: await chainReason(proposal, options),
          command: proposal.steps.map((step) => step.argv.join(" ")).join("\n"),
          signal: ctx.signal,
        });
        if (decision === "deny") return failure("[chat] the user declined the chain; propose steps one at a time");
        return activateProposal(proposal, options);
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
