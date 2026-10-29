import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { buildJobsInstructions } from "@/prompts";
import type { HostApprovalCard } from "../ask-controller";
import type { ChatChains } from "./chain-controller";
import { createChainTools } from "./chain-tools";
import { type ChatJobs, JOB_LOG_TAIL_LINES } from "./job-runner";
import { type ChatJob, type ChatJobKind, JOB_ID_PATTERN } from "./job-types";
import { launchToolRun } from "./jobs-launch";
import type { ChatRunAsks } from "./run-asks";

export const JOBS_LIST_LIMIT = 20;

export interface JobsProviderOptions {
  readonly repoRoot: string;
  readonly naxEntry: readonly string[];
  /** config.execution.maxIterations in pipeline mode; undefined in workflow mode, which ignores it. */
  readonly maxIterations?: number;
  readonly interactionPlugin: string;
  readonly jobs: ChatJobs;
  readonly chains?: ChatChains;
  readonly runAsks?: ChatRunAsks;
  readonly approve: (card: HostApprovalCard) => Promise<"allow" | "deny">;
  readonly sessionId: () => string;
  readonly now: () => Date;
}
const profiles = { type: "array", items: { type: "string" } };
const schemas = {
  plan: { feature: { type: "string" }, spec: { type: "string" }, profiles },
  run: { feature: { type: "string" }, profiles, maxIterations: { type: "integer" }, maxCost: { type: "number" } },
  bot_review: { pr: { type: "integer" }, profiles, model: { type: "string" }, decisions: { type: "string" } },
  bot_fix: {
    pr: { type: "integer" },
    profiles,
    model: { type: "string" },
    trust: { type: "boolean" },
    noRereview: { type: "boolean" },
  },
} satisfies Record<ChatJobKind, Record<string, unknown>>;
const LAUNCH_KINDS: readonly ChatJobKind[] = ["plan", "run", "bot_review", "bot_fix"];

function summary(job: ChatJob): Record<string, unknown> {
  const { id, kind, target, state, startedAt, endedAt, progress, cost, note } = job;
  return { id, kind, target, state, startedAt, endedAt, progress, cost, note };
}

async function cancelJob(job: ChatJob, options: JobsProviderOptions, signal?: AbortSignal): Promise<ToolResult> {
  const preflight = await options.jobs.canCancel(job.id);
  if (!preflight.ok) return { isError: true, content: `[chat] ${preflight.message}` };
  const decision = await options.approve({
    tool: "nax-jobs__cancel",
    summary: `cancel nax ${job.kind} ${job.target} (${job.id})`,
    reason: "Cancelling stops the job; paid work it has done is not refunded.",
    signal,
  });
  if (decision === "deny") {
    return { isError: true, content: `[chat] the user declined to cancel job ${job.id}` };
  }
  await options.jobs.cancel(job.id);
  return { content: `cancel requested for job ${job.id}; SIGINT sent` };
}

function inspectionTool(name: "list" | "cancel", options: JobsProviderOptions): ProviderTool {
  return {
    localName: name,
    description: name === "list" ? "Inspect nax jobs and their recent logs." : "Cancel a nax job; asks the user first.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string" } },
      additionalProperties: false,
      required: name === "cancel" ? ["job"] : [],
    },
    run: async (input, ctx) => {
      if (name === "list" && input.job === undefined) {
        const jobs = options.jobs.list();
        return {
          content: JSON.stringify({
            jobs: jobs.slice(0, JOBS_LIST_LIMIT).map(summary),
            omitted: Math.max(0, jobs.length - JOBS_LIST_LIMIT),
            ...(options.chains ? { chain: options.chains.summary() } : {}),
          }),
        };
      }
      const id = input.job;
      if (typeof id !== "string" || !JOB_ID_PATTERN.test(id)) {
        return { isError: true, content: `[chat] invalid job id ${String(id)}` };
      }
      const job = options.jobs.get(id);
      if (!job) return { isError: true, content: `[chat] unknown job ${id}` };
      return name === "cancel"
        ? cancelJob(job, options, ctx.signal)
        : {
            content: JSON.stringify({ ...job, logTail: await options.jobs.logTail(id, JOB_LOG_TAIL_LINES) }),
          };
    },
  };
}

function answerAskTool(runAsks: ChatRunAsks): ProviderTool {
  return {
    localName: "answer_ask",
    description: "Answer a queued run ask once, with a reason, or escalate it to the user. No approval card.",
    inputSchema: {
      type: "object",
      properties: { ask: { type: "string" }, answer: { type: "string" }, reason: { type: "string" } },
      required: ["ask", "answer", "reason"],
      additionalProperties: false,
    },
    run: async ({ ask, answer, reason }) => {
      if (typeof ask !== "string" || typeof answer !== "string" || typeof reason !== "string") {
        return { isError: true, content: "[chat] answer_ask requires string ask, answer and reason" };
      }
      const result = await runAsks.answer(ask, { answer, reason });
      return result.ok ? { content: `answered run ask ${ask}` } : { isError: true, content: result.message };
    },
  };
}

/** Repo-scoped static tools; billed launches require their own card or chain approval. */
export function createJobsProvider(options: JobsProviderOptions): ToolProvider {
  return {
    id: "nax-jobs",
    kind: "static",
    stages: ["*"],
    instructions: async () => (options.runAsks ? buildJobsInstructions({ answerAsks: true }) : buildJobsInstructions()),
    tools: async () => [
      ...LAUNCH_KINDS.map((kind) => ({
        localName: kind,
        description: `Billed nax ${kind} background launch; asks the user for explicit approval before starting.`,
        inputSchema: {
          type: "object",
          properties: schemas[kind],
          additionalProperties: false,
          required: [kind === "plan" || kind === "run" ? "feature" : "pr"],
        },
        run: launchToolRun(kind, options),
      })),
      inspectionTool("list", options),
      inspectionTool("cancel", options),
      ...(options.chains ? createChainTools({ ...options, chains: options.chains }) : []),
      ...(options.runAsks ? [answerAskTool(options.runAsks)] : []),
    ],
  };
}
