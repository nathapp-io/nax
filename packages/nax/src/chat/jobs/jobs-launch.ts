/** Repo-scoped billed launches. Approval is host-owned, even for a static provider. */
import { join, relative } from "node:path";
import type { ProviderTool, ToolResult } from "@nathapp/nax-agent";
import { errorMessage, isProcessAlive } from "@nathapp/nax-agent/internal";
import { featureDir } from "@/config";
import { countStories, loadPRD } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
import type { ChainAdmission } from "./chain-controller";
import { buildJobArgv, type JobLaunchInput, parseJobInput } from "./job-argv";
import type { ChatJob, ChatJobKind } from "./job-types";
import type { JobsProviderOptions } from "./jobs-provider";

export const _jobsLaunchDeps = {
  git: gitWithTimeout,
  lockHolder,
  readLock: (path: string): Promise<unknown> => Bun.file(path).json(),
  isProcessAlive,
  exists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  loadPRD,
};

/** Advisory read only: execution remains responsible for acquiring the checkout lock. */
async function lockHolder(repoRoot: string): Promise<number | null> {
  try {
    const raw = await _jobsLaunchDeps.readLock(join(repoRoot, "nax.lock"));
    if (typeof raw !== "object" || raw === null || !("pid" in raw)) return null;
    const { pid } = raw;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    return _jobsLaunchDeps.isProcessAlive(pid) ? pid : null;
  } catch {
    // Missing, unreadable or corrupt lock records do not identify a live holder.
    return null;
  }
}

function busyJob(options: JobsProviderOptions): ToolResult | undefined {
  const job = options.jobs
    .running()
    .find((job) => job.cwd === options.repoRoot && (job.kind === "plan" || job.kind === "run"));
  return job
    ? { isError: true, content: `[chat] nax ${job.kind} job ${job.id} is already running in this checkout` }
    : undefined;
}

async function busyLock(options: JobsProviderOptions): Promise<ToolResult | undefined> {
  const pid = await _jobsLaunchDeps.lockHolder(options.repoRoot);
  return pid === null
    ? undefined
    : { isError: true, content: `[chat] this checkout is held by nax pid ${pid}; wait for it or stop it first` };
}

type ApprovedLaunch = {
  readonly argv: readonly string[];
  readonly auto?: Extract<ChainAdmission, { kind: "auto" }>;
  readonly details?: readonly string[];
};

function startedResult(job: ChatJob, launch: ApprovedLaunch): ToolResult {
  const { auto } = launch;
  return {
    content: [
      JSON.stringify({ job: job.id, state: "running", log: job.logPath }),
      ...(auto
        ? [
            `started as step ${auto.step} of chain ${auto.chainId}; no card (approved by the chain card)`,
            ...(launch.details ?? []),
          ]
        : []),
      "A [nax-jobs] notice arrives when it ends.",
    ].join("\n"),
  };
}

async function startApproved(
  input: JobLaunchInput,
  launch: ApprovedLaunch,
  options: JobsProviderOptions,
): Promise<ToolResult> {
  const { argv, auto } = launch;
  if (input.kind === "plan" || input.kind === "run") {
    const held = await busyLock(options);
    if (held) return held;
  }
  try {
    // No await from this final in-memory check to start: the runner registers synchronously.
    const busy = input.kind === "plan" || input.kind === "run" ? busyJob(options) : undefined;
    if (busy) return busy;
    if (auto && !options.chains?.isActive(auto.chainId)) {
      return {
        isError: true,
        content: `[chat] chain ${auto.chainId} stopped before step ${auto.step} started; nothing started`,
      };
    }
    const job = await options.jobs.start({
      kind: input.kind,
      target: "feature" in input ? input.feature : String(input.pr),
      argv,
      sessionId: options.sessionId(),
      approvedAt: auto ? auto.approvedAt : options.now().toISOString(),
      ...(auto ? { chainId: auto.chainId, chainStep: auto.step } : {}),
    });
    if (auto) options.chains?.started(auto.chainId, auto.step, job.id);
    return startedResult(job, launch);
  } catch (cause) {
    const prefix = `could not start nax ${input.kind}: `;
    let message = errorMessage(cause);
    if (message.startsWith(`[chat] ${prefix}`)) message = message.slice("[chat] ".length);
    if (message.startsWith(prefix)) message = message.slice(prefix.length);
    return { isError: true, content: `[chat] ${prefix}${message}` };
  }
}

type Prepared = {
  readonly input: JobLaunchInput;
  readonly details: readonly string[];
  readonly overLimit?: { readonly pending: number; readonly limit: number };
};
type TargetError = { readonly error: string };

async function preparePlan(
  input: Extract<JobLaunchInput, { kind: "plan" }>,
  options: JobsProviderOptions,
): Promise<Prepared | TargetError> {
  const resolved = await resolvePlanSpec(input.feature, input.spec, options);
  if ("error" in resolved) return resolved;
  const details = resolved.prdExists ? ["warning: prd.json exists and will be replaced"] : [];
  return { input: { ...input, spec: resolved.spec }, details };
}

/** Resolve plan inputs without requiring a PRD (a chain may plan before it runs). */
export async function resolvePlanSpec(
  feature: string,
  requestedSpec: string | undefined,
  options: Pick<JobsProviderOptions, "repoRoot">,
): Promise<{ readonly spec: string; readonly prdExists: boolean } | TargetError> {
  const dir = featureDir(options.repoRoot, feature);
  const candidates =
    requestedSpec === undefined
      ? [join(dir, "spec.md"), join(options.repoRoot, ".nax", "specs", `${feature}.md`)]
      : [join(options.repoRoot, requestedSpec)];
  let spec: string | undefined;
  for (const path of candidates) {
    if (await _jobsLaunchDeps.exists(path)) {
      spec = relative(options.repoRoot, path);
      break;
    }
  }
  if (spec === undefined) {
    return {
      error: `[chat] no spec for ${feature}; looked for ${candidates.map((p) => relative(options.repoRoot, p)).join(", ")}`,
    };
  }
  return { spec, prdExists: await _jobsLaunchDeps.exists(join(dir, "prd.json")) };
}

async function prepareRun(
  input: Extract<JobLaunchInput, { kind: "run" }>,
  options: JobsProviderOptions,
): Promise<Prepared | TargetError> {
  const path = join(featureDir(options.repoRoot, input.feature), "prd.json");
  if (!(await _jobsLaunchDeps.exists(path))) {
    return { error: `[chat] no prd.json for ${input.feature}; run nax plan first` };
  }
  let prd: Awaited<ReturnType<typeof loadPRD>>;
  try {
    prd = await _jobsLaunchDeps.loadPRD(path);
  } catch (cause) {
    return { error: `[chat] prd.json for ${input.feature} is unreadable: ${errorMessage(cause)}` };
  }
  const { pending, total } = countStories(prd);
  // Workflow mode bounds the loop by the story count and ignores maxIterations (nax#2706), so there is no limit to compare.
  const limit = options.maxIterations === undefined ? undefined : (input.maxIterations ?? options.maxIterations);
  const details = [
    limit === undefined
      ? `stories ${pending} pending of ${total}`
      : `stories ${pending} pending of ${total}; max iterations ${limit}`,
  ];
  const overLimit = limit !== undefined && pending > limit ? { pending, limit } : undefined;
  if (overLimit)
    details.push(`warning: ${pending} stories pending but max iterations is ${limit}; pass maxIterations (nax#2706)`);
  if (options.interactionPlugin === "cli")
    details.push("asks you do not answer in chat fall to the run's timeout defaults");
  return { input, details, ...(overLimit ? { overLimit } : {}) };
}

async function prepareTarget(input: JobLaunchInput, options: JobsProviderOptions): Promise<Prepared | TargetError> {
  if ("feature" in input) {
    try {
      featureDir(options.repoRoot, input.feature);
    } catch (cause) {
      return { error: errorMessage(cause) };
    }
  }
  if (input.kind === "plan") return preparePlan(input, options);
  if (input.kind === "run") return prepareRun(input, options);
  if (
    input.kind === "bot_review" &&
    input.decisions !== undefined &&
    !(await _jobsLaunchDeps.exists(join(options.repoRoot, input.decisions)))
  ) {
    return { error: `[chat] decisions file ${input.decisions} not found` };
  }
  return { input, details: [] };
}

async function launchReason(prepared: Prepared, options: JobsProviderOptions): Promise<string> {
  const branch = await _jobsLaunchDeps.git(["symbolic-ref", "--short", "HEAD"], options.repoRoot);
  return [
    `workdir ${options.repoRoot}${branch.exitCode === 0 ? ` on branch ${branch.stdout.trim()}` : ""}`,
    `nax ${options.naxEntry.join(" ")}`,
    `profiles ${prepared.input.profiles.join(", ") || "(none)"}`,
    ...prepared.details,
  ].join("\n");
}

/** Parse, prepare, check busy state, then use chain admission or a host card. */
export async function launchJob(
  request: { readonly kind: ChatJobKind; readonly raw: Record<string, unknown>; readonly signal?: AbortSignal },
  options: JobsProviderOptions,
): Promise<ToolResult> {
  const parsed = parseJobInput(request.kind, request.raw);
  if ("error" in parsed) return { isError: true, content: parsed.error };
  const prepared = await prepareTarget(parsed, options);
  if ("error" in prepared) return { isError: true, content: prepared.error };
  const { input } = prepared;
  if (input.kind === "plan" || input.kind === "run") {
    const busy = busyJob(options) ?? (await busyLock(options));
    if (busy) return busy;
  }
  const argv = buildJobArgv(input, options);
  let admission = options.chains?.admit({ kind: input.kind, argv, ...("pr" in input ? { pr: input.pr } : {}) });
  if (admission?.kind === "auto" && prepared.overLimit) {
    const { pending, limit } = prepared.overLimit;
    const reason = `step ${admission.step}: ${pending} stories pending but max iterations is ${limit} (nax#2706)`;
    options.chains?.stop(reason);
    admission = { kind: "card", note: `chain ${admission.chainId} stopped: ${reason}` };
  }
  if (admission?.kind === "auto") {
    const result = await startApproved(input, { argv, auto: admission, details: prepared.details }, options);
    if (result.isError)
      options.chains?.startFailed(admission.chainId, admission.step, result.content.replace(/^\[chat\] /, ""));
    return result;
  }
  return approvePrepared({ prepared, argv, note: admission?.note, signal: request.signal }, options);
}

async function approvePrepared(
  launch: {
    readonly prepared: Prepared;
    readonly argv: readonly string[];
    readonly note?: string;
    readonly signal?: AbortSignal;
  },
  options: JobsProviderOptions,
): Promise<ToolResult> {
  const { prepared, argv } = launch;
  const { input } = prepared;
  const target = "feature" in input ? input.feature : String(input.pr);
  const summary =
    "feature" in input
      ? `nax ${input.kind} ${target}`
      : `nax bot ${input.kind === "bot_review" ? "review" : "fix"} #${target}`;
  const reason = await launchReason(prepared, options);
  const decision = await options.approve({
    tool: `nax-jobs__${input.kind}`,
    summary,
    command: argv.join(" "),
    reason: launch.note === undefined ? reason : `${reason}\n${launch.note}`,
    signal: launch.signal,
  });
  if (decision === "deny") {
    return {
      isError: true,
      content: `[chat] the user declined ${summary}; do not retry with different arguments unless the user asks`,
    };
  }
  return startApproved(input, { argv }, options);
}

/** Adapter keeps the launch flow independent of static-provider approval behavior. */
export function launchToolRun(kind: ChatJobKind, options: JobsProviderOptions): ProviderTool["run"] {
  return (raw, ctx) => launchJob({ kind, raw, signal: ctx.signal }, options);
}
