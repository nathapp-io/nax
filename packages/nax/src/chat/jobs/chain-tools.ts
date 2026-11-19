/** Repo-scoped chain proposals: validate the whole proposal before host approval. */
import type { ProviderTool, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { WorkflowPublishMode } from "@/config";
import {
  type FlowHandoffInput,
  formatHandoffCostCap,
  handoffStepArgv,
  parseFlowHandoffInput,
} from "../flow/flow-handoff-input";
import { resolveTargetRepo } from "../target-repo";
import {
  buildChainStepArgv,
  CHAIN_STEP_FIELDS,
  type ChainStepInput,
  chainStepFieldError,
  parseChainStepInput,
} from "./chain-argv";
import type { ChatChains } from "./chain-controller";
import { CHAIN_CHECK_MAX_LENGTH, CHAIN_MAX_STEPS, type ChainStep, type ChainStepKind } from "./chain-types";
import { type ChatJobKind, isRunJobKind } from "./job-types";
import { _jobsLaunchDeps, featureBranchRefusal, resolvePlanSpec } from "./jobs-launch";
import type { JobsProviderOptions } from "./jobs-provider";
import { applyWorkflowDefaults, unknownWorkflowProfile } from "./workflow-defaults";

const BOT_PR_OFFSET = 2;
/** US-007: the three refusals a handoff step adds to the proposal's own. */
const HANDOFF_UNAVAILABLE = "handoff needs a koda connection (memory.koda in the nax config)";
const HANDOFF_LAST_STEP = "a handoff must be the chain's last step";
const HANDOFF_CHECK_REFUSAL = "a handoff step takes no checkBefore";
/** US-007: what the card says about who approves the flow koda bills. */
const HANDOFF_BILLING_NOTE = "koda asks for its own approval before anything billed starts";

type Options = JobsProviderOptions & { readonly chains: ChatChains };
type InputError = { readonly error: string };
type JobStep = { readonly input: ChainStepInput; readonly checkBefore?: string };
type ParsedStep = ({ readonly kind: "job" } & JobStep) | { readonly kind: "handoff"; readonly input: FlowHandoffInput };
/** A step's own position in the proposal, and what the proposal's rules need to know about it. */
type StepContext = { readonly step: number; readonly total: number; readonly options: Options };

export interface ResolvedChainProposal {
  readonly steps: readonly ChainStep[];
  readonly costCap?: number;
  readonly handoff?: FlowHandoffInput;
  readonly existingPlanPrds: readonly { readonly step: number; readonly feature: string }[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function stepKind(value: unknown): value is ChainStepKind {
  return typeof value === "string" && Object.hasOwn(CHAIN_STEP_FIELDS, value);
}
function stepError(step: number, message: string): InputError {
  return { error: `[chat] step ${step}: ${message.replace(/^\[chat\] /, "")}` };
}

/**
 * US-007: the handoff form of a step. Its body is `nax-flow__send`'s own handoff input — one
 * feature, its two role models and koda's cap — parsed by the module that owns it, so the
 * chain and the tool refuse the same requests with the same words. It takes no `repo` (it
 * runs in the chat's checkout, where the run it hands over ran) and no `checkBefore` (a job's
 * check has nothing to verify before a flow is created).
 */
function parseHandoffStep(
  body: Record<string, unknown>,
  checkBefore: unknown,
  ctx: StepContext,
): ParsedStep | InputError {
  if (ctx.options.handoffAvailable !== true) return stepError(ctx.step, HANDOFF_UNAVAILABLE);
  const unknown = chainStepFieldError("handoff", body);
  if (unknown !== undefined) return stepError(ctx.step, unknown);
  if (ctx.step !== ctx.total) return stepError(ctx.step, HANDOFF_LAST_STEP);
  if (checkBefore !== undefined) return stepError(ctx.step, HANDOFF_CHECK_REFUSAL);
  const input = parseFlowHandoffInput({
    handoff: { feature: body.feature },
    roles: body.roles,
    costCapUsd: body.costCapUsd,
  });
  if ("errors" in input) return stepError(ctx.step, input.errors.join("; "));
  return { kind: "handoff", input };
}

function parseStep(raw: unknown, ctx: StepContext): ParsedStep | InputError {
  if (!plainObject(raw) || !plainObject(raw.input)) return stepError(ctx.step, "input must be an object");
  if (!stepKind(raw.kind)) return stepError(ctx.step, `unknown kind ${String(raw.kind)}`);
  // Before the job parser: a handoff's input is the flow tool's, not a launch's.
  if (raw.kind === "handoff") return parseHandoffStep(raw.input, raw.checkBefore, ctx);
  const input = parseChainStepInput(raw.kind, raw.input);
  if ("error" in input) return stepError(ctx.step, input.error);
  const { checkBefore } = raw;
  if (
    checkBefore !== undefined &&
    (typeof checkBefore !== "string" || checkBefore.length < 1 || checkBefore.length > CHAIN_CHECK_MAX_LENGTH)
  ) {
    return stepError(ctx.step, `checkBefore must be 1 to ${CHAIN_CHECK_MAX_LENGTH} characters`);
  }
  return { kind: "job", input, ...(checkBefore === undefined ? {} : { checkBefore }) };
}

type StepTarget = {
  readonly input: ChainStepInput;
  readonly options: Options;
  readonly prdExists: boolean;
  readonly checkBefore?: string;
};

/** Resolves the step's repo, then its plan spec, against that repo. */
async function resolveStepTarget(entry: JobStep, step: number, options: Options): Promise<StepTarget | InputError> {
  const { input } = entry;
  const target = await resolveTargetRepo(options.repoRoot, input.repo);
  if ("error" in target) return stepError(step, target.error);
  const stepOptions = { ...options, repoRoot: target.root };
  // Config defaults first: the card's argv must be the argv the step's own launch will build.
  const applied = applyWorkflowDefaults(input, stepOptions.workflow);
  const body = applied.input;
  let prepared: ChainStepInput = body;
  let prdExists = false;
  if (body.kind === "plan") {
    const resolved = await resolvePlanSpec(body.feature, body.spec, stepOptions);
    if ("error" in resolved) return stepError(step, resolved.error);
    // After the spec: a missing spec is the more actionable report of the two.
    prepared = { ...body, spec: resolved.spec };
    prdExists = resolved.prdExists;
  }
  const unknown = await unknownWorkflowProfile(applied, stepOptions.repoRoot);
  if (unknown !== undefined) return stepError(step, unknown);
  if (body.kind === "plan" || body.kind === "run") {
    const refusal = await featureBranchRefusal({
      kind: body.kind,
      feature: body.feature,
      repoRoot: stepOptions.repoRoot,
    });
    if (refusal !== undefined) return stepError(step, refusal);
  }
  return {
    input: prepared,
    options: stepOptions,
    prdExists,
    ...(entry.checkBefore === undefined ? {} : { checkBefore: entry.checkBefore }),
  };
}

/**
 * US-007: what a later handoff step must know about an earlier one — its feature, the run's own
 * publish mode and where it runs. `feature` is absent for a bot step, which hands nothing over.
 */
interface EarlierStep {
  readonly step: number;
  readonly kind: ChatJobKind;
  readonly feature?: string;
  readonly publish?: WorkflowPublishMode;
  readonly root: string;
}

/**
 * US-007: a handoff is only worth proposing when the feature still has something to hand over.
 * An earlier step of the same feature must leave it unpublished — a run without `publish: "none"`
 * publishes its own PR, and a publish step publishes it outright — and it must run in the chat's
 * own checkout, because the handoff reads the run record from there.
 */
function handoffRefusal(
  input: FlowHandoffInput,
  step: number,
  earlier: readonly EarlierStep[],
  chatRoot: string,
): InputError | undefined {
  const { feature } = input;
  const runs = earlier.filter((entry) => entry.kind === "run" && entry.feature === feature);
  const publishing = runs.find((entry) => entry.publish !== "none");
  if (publishing !== undefined) {
    return stepError(
      step,
      `step ${publishing.step} runs ${feature} without publish "none", so it would publish its own PR before the handoff`,
    );
  }
  const publisher = earlier.find((entry) => entry.kind === "publish" && entry.feature === feature);
  if (publisher !== undefined) {
    return stepError(step, `step ${publisher.step} publishes ${feature}, so there would be nothing to hand off`);
  }
  const elsewhere = runs.find((entry) => entry.root !== chatRoot);
  if (elsewhere !== undefined) {
    return stepError(
      step,
      `the handoff runs in ${chatRoot}, but step ${elsewhere.step} runs ${feature} in ${elsewhere.root}`,
    );
  }
  return undefined;
}

/** What the handoff refusals read about the job step just resolved. */
function earlierStep(step: number, resolved: StepTarget): EarlierStep {
  const { input } = resolved;
  return {
    step,
    kind: input.kind,
    ...("feature" in input ? { feature: input.feature } : {}),
    ...(input.kind === "run" ? { publish: input.publish } : {}),
    root: resolved.options.repoRoot,
  };
}

/** A resolved job step as the chain records it, beside the facts a later handoff checks. */
function jobStep(step: number, resolved: StepTarget, options: Options): { chainStep: ChainStep; earlier: EarlierStep } {
  const { input } = resolved;
  const prless = (input.kind === "bot_review" || input.kind === "bot_fix") && input.pr === undefined;
  return {
    chainStep: {
      kind: input.kind,
      argv: buildChainStepArgv(input, resolved.options),
      target: "feature" in input ? input.feature : input.pr === undefined ? "" : String(input.pr),
      // The bot PR token follows the two command tokens, independently of the entry length.
      ...(prless ? { prIndex: options.naxEntry.length + BOT_PR_OFFSET } : {}),
      ...(resolved.checkBefore === undefined ? {} : { checkBefore: resolved.checkBefore }),
    },
    earlier: earlierStep(step, resolved),
  };
}

/** A handoff step's chain entry: the flow tool's own call, in the chat's checkout. */
function handoffStep(input: FlowHandoffInput): ChainStep {
  return { kind: "handoff", argv: handoffStepArgv(input), target: input.feature };
}

async function resolveSteps(
  parsed: readonly ParsedStep[],
  options: Options,
): Promise<ResolvedChainProposal | InputError> {
  const steps: ChainStep[] = [];
  const earlier: EarlierStep[] = [];
  let handoff: FlowHandoffInput | undefined;
  const existingPlanPrds: { step: number; feature: string }[] = [];
  for (const [index, entry] of parsed.entries()) {
    const step = index + 1;
    // A handoff runs no launch and reads no repo: it is the flow tool's own call, in the chat's checkout.
    if (entry.kind === "handoff") {
      const refusal = handoffRefusal(entry.input, step, earlier, options.repoRoot);
      if (refusal !== undefined) return refusal;
      handoff = entry.input;
      steps.push(handoffStep(handoff));
      continue;
    }
    const resolved = await resolveStepTarget(entry, step, options);
    if ("error" in resolved) return resolved;
    const { chainStep, earlier: facts } = jobStep(step, resolved, options);
    const plan = resolved.input.kind === "plan" && resolved.prdExists;
    if (plan) existingPlanPrds.push({ step, feature: resolved.input.feature });
    steps.push(chainStep);
    earlier.push(facts);
  }
  return { steps, existingPlanPrds, ...(handoff === undefined ? {} : { handoff }) };
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
  // Match the card's decimal representation without rejecting valid cents due to binary multiplication noise.
  if (costCap !== undefined && Number(costCap.toFixed(2)) !== costCap) {
    return { error: "[chat] costCap must have at most two decimal places" };
  }
  const parsed: ParsedStep[] = [];
  for (const [index, rawStep] of raw.steps.entries()) {
    const step = parseStep(rawStep, { step: index + 1, total: raw.steps.length, options });
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
  if (step.kind === "handoff") return `hand ${step.target} to koda`;
  if (step.kind === "plan" || step.kind === "run") return `nax ${step.kind} ${step.target}`;
  if (step.kind === "publish") return `nax run ${step.target} --publish-only`;
  const action = step.kind === "bot_review" ? "review" : "fix";
  return `nax bot ${action} ${step.prIndex === undefined ? `#${step.target}` : "(PR chosen by the agent)"}`;
}

function stepReason(step: ChainStep, index: number, handoff: FlowHandoffInput | undefined): string {
  const condition = index === 0 ? "you approve this card" : `step ${index} succeeded`;
  // The same validated input builds the authorized argv and the card details. Values may look like flags.
  if (step.kind === "handoff" && handoff !== undefined) {
    const { roles, costCapUsd } = handoff;
    const detail = `reviewer ${roles.reviewer}, supervisor ${roles.supervisor}, cost cap $${formatHandoffCostCap(costCapUsd)}`;
    return `${index + 1}. ${stepLabel(step)} (${detail}) — starts after: ${condition}`;
  }
  const check = step.checkBefore === undefined ? "" : ` and check "${step.checkBefore}" passed`;
  const pr = step.prIndex === undefined ? "" : " — the agent picks the PR when the step starts";
  return `${index + 1}. ${stepLabel(step)} — starts after: ${condition}${check}${pr}`;
}

/**
 * US-002: in workflow mode `nax run` publishes its own PR, so a publish step placed after a run of
 * the same feature is refused whenever that run published one. The card says so before approval.
 */
function publishAfterRunWarnings(steps: readonly ChainStep[]): readonly string[] {
  return steps.flatMap((step, index) => {
    if (step.kind !== "publish") return [];
    const run = steps.findLastIndex((other, i) => i < index && other.kind === "run" && other.target === step.target);
    return run === -1
      ? []
      : [
          `warning: step ${index + 1} publishes ${step.target} after step ${run + 1} runs it; a workflow-mode run publishes its own PR, so step ${index + 1} is refused if that run published one`,
        ];
  });
}

async function chainReason(proposal: ResolvedChainProposal, options: Options): Promise<string> {
  const branch = await _jobsLaunchDeps.git(["symbolic-ref", "--short", "HEAD"], options.repoRoot);
  const runs = proposal.steps.some((step) => step.kind !== "handoff" && isRunJobKind(step.kind));
  return [
    `workdir ${options.repoRoot}${branch.exitCode === 0 ? ` on branch ${branch.stdout.trim()}` : ""}`,
    `nax ${options.naxEntry.join(" ")}`,
    ...proposal.steps.map((step, index) => stepReason(step, index, proposal.handoff)),
    proposal.costCap === undefined
      ? "no cost cap"
      : `cost cap $${proposal.costCap.toFixed(2)}, checked between steps; plan and bot job costs are not counted`,
    ...proposal.existingPlanPrds.map(
      ({ step, feature }) => `warning: step ${step} replaces the existing prd.json for ${feature}`,
    ),
    ...publishAfterRunWarnings(proposal.steps),
    ...(options.interactionPlugin === "cli" && runs
      ? ["run steps' asks you do not answer in chat fall to their timeout defaults"]
      : []),
    // US-007: the flow's own approval is the one gate this chain does not hold.
    ...(proposal.steps.some((step) => step.kind === "handoff") ? [HANDOFF_BILLING_NOTE] : []),
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
          // A handoff pushes a branch and uploads the run record before koda bills anything,
          // so a chain carrying one is carded even in full mode.
          ...(proposal.steps.some((step) => step.kind === "handoff") ? { requiresHostApproval: true as const } : {}),
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
      run: async ({ step, passed, note }) => {
        if (
          typeof step !== "number" ||
          !Number.isInteger(step) ||
          typeof passed !== "boolean" ||
          typeof note !== "string"
        ) {
          return failure("[chat] chain_check requires an integer step, boolean passed and string note");
        }
        const result = options.chains.recordCheck(step, passed, note);
        return result.ok
          ? { content: `check recorded for step ${step}${passed ? "" : "; the chain stopped"}` }
          : failure(`[chat] ${result.message}`);
      },
    },
    {
      localName: "chain_stop",
      description: "Stop chain autonomy without cancelling running jobs.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] },
      run: async () => {
        if (!options.chains.active()) return failure("[chat] no active chain");
        const chain = options.chains.stop("stopped by the agent");
        return chain
          ? { content: `chain ${chain.id} stopped; running jobs keep running` }
          : failure("[chat] no active chain");
      },
    },
  ];
}
