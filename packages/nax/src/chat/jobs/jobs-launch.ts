/** Repo-scoped billed launches. Approval is host-owned, even for a static provider. */
import { join, relative } from "node:path";
import type { ProviderTool, ToolResult } from "@nathapp/nax-agent";
import { errorMessage, isProcessAlive } from "@nathapp/nax-agent/internal";
import { featureDir } from "@/config";
import { headSha } from "@/finish";
import { countStories, loadPRD } from "@/prd";
import { gitWithTimeout, isPublishableBranch } from "@/utils/git";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { loadPriorFeature } from "../../workflow/feature-record";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { handoffMarkRefusal, readNewestHandoffMark } from "../../workflow/handoff-mark";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { workflowFeatureDir } from "../../workflow/paths";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { publishedAtHead } from "../../workflow/publish-only";
import { resolveTargetRepo } from "../target-repo";
import type { ChainAdmission } from "./chain-controller";
import { buildJobArgv, type JobLaunchInput, parseJobInput } from "./job-argv";
import { type ChatJob, type ChatJobKind, isFeatureJobKind } from "./job-types";
import type { JobsProviderOptions } from "./jobs-provider";
import { applyWorkflowDefaults, unknownWorkflowProfile, type WorkflowDefaultsApplied } from "./workflow-defaults";

export const _jobsLaunchDeps = {
  git: gitWithTimeout,
  lockHolder,
  readLock: (path: string): Promise<unknown> => Bun.file(path).json(),
  isProcessAlive,
  exists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  loadPRD,
  loadPriorFeature,
  readNewestHandoffMark,
  headSha,
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
  const job = options.jobs.running().find((job) => job.cwd === options.repoRoot && isFeatureJobKind(job.kind));
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

/** How the refusal names a branch that `git symbolic-ref` reported as the empty string. */
const UNNAMED_BRANCH = "an unnamed branch";

/** The planner's default branch for a feature, used when its PRD names no other (`plan/strategies/context-builder.ts`). */
function defaultFeatureBranch(feature: string): string {
  return `feat/${feature}`;
}

/** The branch a feature's plan and run belong on: its PRD's branchName, else the planner's default. */
async function featureTargetBranch(feature: string, repoRoot: string): Promise<string> {
  const path = join(featureDir(repoRoot, feature), "prd.json");
  if (!(await _jobsLaunchDeps.exists(path))) return defaultFeatureBranch(feature);
  try {
    const prd = await _jobsLaunchDeps.loadPRD(path);
    // `loadPRD` does not validate `branchName`, so a malformed or legacy PRD may carry none.
    const { branchName } = prd;
    return typeof branchName === "string" && branchName !== "" ? branchName : defaultFeatureBranch(feature);
  } catch {
    // An unreadable PRD cannot name its branch; the planner's default is still the right target.
    return defaultFeatureBranch(feature);
  }
}

/**
 * Refuses a feature's plan or run while the checkout is on main, master or an
 * unnamed branch: the launch would commit the run onto a protected branch.
 * A branch git cannot name (detached HEAD, not a repository) is not refused.
 */
export async function featureBranchRefusal(input: {
  readonly kind: "plan" | "run";
  readonly feature: string;
  readonly repoRoot: string;
}): Promise<string | undefined> {
  const branch = await _jobsLaunchDeps.git(["symbolic-ref", "--short", "HEAD"], input.repoRoot);
  if (branch.exitCode !== 0) return undefined;
  const name = branch.stdout.trim();
  if (isPublishableBranch(name)) return undefined;
  const target = await featureTargetBranch(input.feature, input.repoRoot);
  const shown = name === "" ? UNNAMED_BRANCH : name;
  return `[chat] nax ${input.kind} for ${input.feature} refused: the checkout is on ${shown}; plan and run a feature on its feature branch ${target}. Create or check out ${target}, then launch again.`;
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

/**
 * The branch guard, read again as the job is about to start: a card can sit open while the user
 * switches the checkout, and the branch that was allowed when the card was drawn is not the one
 * the job would commit onto. An approval is not a licence to run on a protected branch.
 */
async function branchRefusalAfterApproval(
  input: JobLaunchInput,
  options: JobsProviderOptions,
): Promise<ToolResult | undefined> {
  if (input.kind !== "plan" && input.kind !== "run") return undefined;
  const refusal = await featureBranchRefusal({ kind: input.kind, feature: input.feature, repoRoot: options.repoRoot });
  return refusal === undefined ? undefined : { isError: true, content: refusal };
}

async function startApproved(
  input: JobLaunchInput,
  launch: ApprovedLaunch,
  options: JobsProviderOptions,
): Promise<ToolResult> {
  const { argv, auto } = launch;
  // The lock read comes first, and the branch is read after it: a checkout change during the lock
  // read would otherwise land behind a branch the guard had already approved. Both reads still
  // happen after the approval the caller waited on.
  if (isFeatureJobKind(input.kind)) {
    const held = await busyLock(options);
    if (held) return held;
  }
  const moved = await branchRefusalAfterApproval(input, options);
  if (moved) return moved;
  try {
    // No await from this final in-memory check to start: the runner registers synchronously.
    const busy = isFeatureJobKind(input.kind) ? busyJob(options) : undefined;
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
      cwd: options.repoRoot,
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
  /** Replaces the card's `profiles` line when the run adopts the PRD's planned profile. */
  readonly profileLine?: string;
};
/** Where `chat.workflow` supplied the values on the card, so the user sees the choice's origin. */
type Provenance = Pick<WorkflowDefaultsApplied<unknown>, "profilesFrom" | "modelFrom">;
type TargetError = { readonly error: string; readonly publishedAtHead?: true };

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

/**
 * The chain a PRD was planned with: plan stamps the loader's composite name, which joins a chain
 * with `+` (#2814), and `default` means no overlay. Used only to describe the launch on its card.
 */
function plannedProfileChain(routingProfile: string | undefined): readonly string[] {
  if (routingProfile === undefined || routingProfile === "default") return [];
  return routingProfile
    .split(/[+,]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
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
  const details = [`stories ${pending} pending of ${total}`];
  const planned = plannedProfileChain(prd.routingProfile);
  const plannedName = prd.routingProfile ?? "";
  if (input.profiles.length > 0 && planned.length > 0 && input.profiles.join(",") !== planned.join(",")) {
    details.push(`warning: the PRD was planned with profile ${plannedName}, not ${input.profiles.join(", ")}`);
  }
  const profileLine =
    input.profiles.length === 0 && planned.length > 0
      ? `profiles (none); the run uses the PRD's planned profile ${plannedName}`
      : undefined;
  if (options.interactionPlugin === "cli")
    details.push("asks you do not answer in chat fall to the run's timeout defaults");
  return { input, details, ...(profileLine === undefined ? {} : { profileLine }) };
}

/** How many characters of HEAD a refusal names. */
const HEAD_SHORT = 7;

/** The flag every launch argv spells its project directory with (`nax run -f f1 -d <root>`). */
const DIR_FLAG = "-d";

/**
 * The repository a chain step runs in, read from its argv — the chain record keeps no repo field.
 * A step whose argv names none runs in the chat's own checkout, which is what its launch builds.
 */
function stepRepoRoot(argv: readonly string[], chatRoot: string): string {
  const index = argv.indexOf(DIR_FLAG);
  return (index === -1 ? undefined : argv[index + 1]) ?? chatRoot;
}

/**
 * US-002: whether the chain's next step is exactly the publish this refusal stopped. A feature name
 * alone is not enough: the same feature name can exist in two repositories, and refusing one must
 * not stop an approved step that runs in the other.
 */
function isRefusedPublishStep(
  step: { readonly kind: string; readonly target: string; readonly argv: readonly string[] } | undefined,
  input: JobLaunchInput,
  repoRoot: string,
): boolean {
  if (input.kind !== "publish" || step?.kind !== "publish" || step.target !== input.feature) return false;
  return stepRepoRoot(step.argv, repoRoot) === repoRoot;
}

/**
 * US-002: already published at this HEAD. An advisory read: an unreadable record or HEAD refuses
 * nothing, because the workflow's own publish-only checks decide, on their own reads.
 */
async function publishedRefusal(feature: string, repoRoot: string): Promise<string | undefined> {
  const [prior, head] = await Promise.all([
    _jobsLaunchDeps.loadPriorFeature(workflowFeatureDir(repoRoot, feature), "").catch(() => null),
    _jobsLaunchDeps.headSha(repoRoot).catch(() => null),
  ]);
  const published = publishedAtHead(prior, head ?? undefined);
  if (head === null || published === undefined) return undefined;
  const pr = published.url === undefined ? "PR" : `PR ${published.url}`;
  return `[chat] ${feature} is already published at HEAD ${head.slice(0, HEAD_SHORT)} as a ${published.outcome} ${pr}; nothing to publish: use nax-jobs__bot_review for its open items`;
}

/**
 * #2819: a publish job reruns only the workflow's publish step, so every story must have passed. The
 * workflow itself refuses a run with no finished record or a moved HEAD; the card says what it does.
 */
async function preparePublish(
  input: Extract<JobLaunchInput, { kind: "publish" }>,
  options: JobsProviderOptions,
): Promise<Prepared | TargetError> {
  const path = join(featureDir(options.repoRoot, input.feature), "prd.json");
  if (!(await _jobsLaunchDeps.exists(path))) {
    return { error: `[chat] no prd.json for ${input.feature}; run nax plan and nax run first` };
  }
  let prd: Awaited<ReturnType<typeof loadPRD>>;
  try {
    prd = await _jobsLaunchDeps.loadPRD(path);
  } catch (cause) {
    return { error: `[chat] prd.json for ${input.feature} is unreadable: ${errorMessage(cause)}` };
  }
  const { pending } = countStories(prd);
  if (pending > 0) {
    return { error: `[chat] ${input.feature} has ${pending} pending stories; finish them with nax-jobs__run first` };
  }
  // US-004: koda is this feature's publisher once a handoff marked it. `publishedAtHead: true` routes the
  // refusal through `stopRefusedPublishStep`, so a chain whose next step is this publish stops instead of
  // waiting for a step that can never start.
  const handedOff = await _jobsLaunchDeps.readNewestHandoffMark(workflowFeatureDir(options.repoRoot, input.feature));
  if (handedOff !== null)
    return { error: `[chat] ${handoffMarkRefusal(input.feature, handedOff)}`, publishedAtHead: true };
  // After the pending-story guard: a feature that is not finished has a more actionable report.
  const refusal = await publishedRefusal(input.feature, options.repoRoot);
  if (refusal !== undefined) return { error: refusal, publishedAtHead: true };
  return {
    input,
    details: [
      "publish only: reruns the workflow's publish step from its last finished run; no story, review or fix runs",
      "pushes the branch and opens the PR; a CI repair round may still run an agent",
    ],
  };
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
  if (input.kind === "publish") return preparePublish(input, options);
  if (
    input.kind === "bot_review" &&
    input.decisions !== undefined &&
    !(await _jobsLaunchDeps.exists(join(options.repoRoot, input.decisions)))
  ) {
    return { error: `[chat] decisions file ${input.decisions} not found` };
  }
  return { input, details: [] };
}

/** The card's `model` detail line, present only when `chat.workflow` supplied the model. */
function modelLines(input: JobLaunchInput, modelFrom: string | undefined): readonly string[] {
  const model = "model" in input ? input.model : undefined;
  return modelFrom === undefined || model === undefined ? [] : [`model ${model} (${modelFrom})`];
}

function profilesLine(prepared: Prepared, profilesFrom: string | undefined): string {
  if (prepared.profileLine !== undefined) return prepared.profileLine;
  const names = prepared.input.profiles.join(", ") || "(none)";
  return profilesFrom === undefined ? `profiles ${names}` : `profiles ${names} (${profilesFrom})`;
}

async function launchReason(prepared: Prepared, options: JobsProviderOptions, from: Provenance): Promise<string> {
  const branch = await _jobsLaunchDeps.git(["symbolic-ref", "--short", "HEAD"], options.repoRoot);
  return [
    `workdir ${options.repoRoot}${branch.exitCode === 0 ? ` on branch ${branch.stdout.trim()}` : ""}`,
    `nax ${options.naxEntry.join(" ")}`,
    profilesLine(prepared, from.profilesFrom),
    ...modelLines(prepared.input, from.modelFrom),
    ...prepared.details,
  ].join("\n");
}

/**
 * US-002: a refusal before admission leaves the chain active, so a chain whose next step is exactly
 * the publish that was refused would wait forever. Stop it with the same words the tool returned.
 */
function stopRefusedPublishStep(error: string, input: JobLaunchInput, options: JobsProviderOptions): ToolResult {
  const next = options.chains?.summary()?.next;
  const step = next === undefined ? undefined : options.chains?.active()?.steps[next - 1];
  if (isRefusedPublishStep(step, input, options.repoRoot)) options.chains?.stop(error.replace(/^\[chat\] /, ""));
  return { isError: true, content: error };
}

/** Parse, prepare, check busy state, then use chain admission or a host card. */
export async function launchJob(
  request: { readonly kind: ChatJobKind; readonly raw: Record<string, unknown>; readonly signal?: AbortSignal },
  chatOptions: JobsProviderOptions,
): Promise<ToolResult> {
  const target = await resolveTargetRepo(chatOptions.repoRoot, request.raw.repo);
  if ("error" in target) return { isError: true, content: target.error };
  // Everything below runs against the resolved root, exactly as it did against the chat's own.
  const options: JobsProviderOptions = { ...chatOptions, repoRoot: target.root };
  const parsed = parseJobInput(request.kind, request.raw);
  if ("error" in parsed) return { isError: true, content: parsed.error };
  const applied = applyWorkflowDefaults(parsed, options.workflow);
  const prepared = await prepareTarget(applied.input, options);
  if ("error" in prepared) {
    return prepared.publishedAtHead === true
      ? stopRefusedPublishStep(prepared.error, applied.input, options)
      : { isError: true, content: prepared.error };
  }
  // After the target: a missing spec or PRD is the more actionable report of the two.
  const unknown = await unknownWorkflowProfile(applied, options.repoRoot);
  if (unknown !== undefined) return { isError: true, content: unknown };
  const from: Provenance = applied;
  const { input } = prepared;
  // Before the busy check: a protected checkout refuses regardless of what else is running here.
  if (input.kind === "plan" || input.kind === "run") {
    const refusal = await featureBranchRefusal({
      kind: input.kind,
      feature: input.feature,
      repoRoot: options.repoRoot,
    });
    if (refusal !== undefined) return { isError: true, content: refusal };
  }
  if (isFeatureJobKind(input.kind)) {
    const busy = busyJob(options) ?? (await busyLock(options));
    if (busy) return busy;
  }
  const argv = buildJobArgv(input, options);
  const admission = options.chains?.admit({ kind: input.kind, argv, ...("pr" in input ? { pr: input.pr } : {}) });
  if (admission?.kind === "auto") {
    const result = await startApproved(input, { argv, auto: admission, details: prepared.details }, options);
    if (result.isError)
      options.chains?.startFailed(admission.chainId, admission.step, result.content.replace(/^\[chat\] /, ""));
    return result;
  }
  return approvePrepared({ prepared, argv, from, note: admission?.note, signal: request.signal }, options);
}

async function approvePrepared(
  launch: {
    readonly prepared: Prepared;
    readonly argv: readonly string[];
    readonly from: Provenance;
    readonly note?: string;
    readonly signal?: AbortSignal;
  },
  options: JobsProviderOptions,
): Promise<ToolResult> {
  const { prepared, argv } = launch;
  const { input } = prepared;
  const target = "feature" in input ? input.feature : String(input.pr);
  const summary =
    input.kind === "publish"
      ? `nax run ${target} --publish-only`
      : "feature" in input
        ? `nax ${input.kind} ${target}`
        : `nax bot ${input.kind === "bot_review" ? "review" : "fix"} #${target}`;
  const reason = await launchReason(prepared, options, launch.from);
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
