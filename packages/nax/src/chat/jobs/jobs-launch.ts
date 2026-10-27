/** Repo-scoped billed launches. Approval is host-owned, even for a static provider. */
import { join, relative } from "node:path";
import type { ProviderTool, ToolResult } from "@nathapp/nax-agent";
import { featureDir } from "@/config";
import { countStories, loadPRD } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
import { buildJobArgv, type JobLaunchInput, parseJobInput } from "./job-argv";
import type { ChatJobKind } from "./job-types";
import type { JobsProviderOptions } from "./jobs-provider";

export const _jobsLaunchDeps = {
  git: gitWithTimeout,
  // US-010 supplies the real lock reader and busy checks.
  lockHolder: async (_repoRoot: string): Promise<number | null> => null,
  exists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  loadPRD,
};

type Prepared = { readonly input: JobLaunchInput; readonly details: readonly string[] };
type TargetError = { readonly error: string };

async function preparePlan(
  input: Extract<JobLaunchInput, { kind: "plan" }>,
  options: JobsProviderOptions,
): Promise<Prepared | TargetError> {
  const dir = featureDir(options.repoRoot, input.feature);
  const candidates =
    input.spec === undefined
      ? [join(dir, "spec.md"), join(options.repoRoot, ".nax", "specs", `${input.feature}.md`)]
      : [join(options.repoRoot, input.spec)];
  let spec: string | undefined;
  for (const path of candidates) {
    if (await _jobsLaunchDeps.exists(path)) {
      spec = relative(options.repoRoot, path);
      break;
    }
  }
  if (spec === undefined) {
    return {
      error: `[chat] no spec for ${input.feature}; looked for ${candidates.map((p) => relative(options.repoRoot, p)).join(", ")}`,
    };
  }
  const details = (await _jobsLaunchDeps.exists(join(dir, "prd.json")))
    ? ["warning: prd.json exists and will be replaced"]
    : [];
  return { input: { ...input, spec }, details };
}

async function prepareRun(
  input: Extract<JobLaunchInput, { kind: "run" }>,
  options: JobsProviderOptions,
): Promise<Prepared | TargetError> {
  const path = join(featureDir(options.repoRoot, input.feature), "prd.json");
  if (!(await _jobsLaunchDeps.exists(path))) {
    return { error: `[chat] no prd.json for ${input.feature}; run nax plan first` };
  }
  const { pending, total } = countStories(await _jobsLaunchDeps.loadPRD(path));
  const limit = input.maxIterations ?? options.maxIterations;
  const details = [`stories ${pending} pending of ${total}; max iterations ${limit}`];
  if (pending > limit)
    details.push(`warning: ${pending} stories pending but max iterations is ${limit}; pass maxIterations (nax#2706)`);
  if (options.interactionPlugin === "cli")
    details.push("warning: this run has no channel for its own asks; they will time out");
  return { input, details };
}

async function prepareTarget(input: JobLaunchInput, options: JobsProviderOptions): Promise<Prepared | TargetError> {
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

/** Parse, validate target, ask explicitly, then launch only the approved argv. */
export async function launchJob(
  request: { readonly kind: ChatJobKind; readonly raw: Record<string, unknown>; readonly signal?: AbortSignal },
  options: JobsProviderOptions,
): Promise<ToolResult> {
  const parsed = parseJobInput(request.kind, request.raw);
  if ("error" in parsed) return { isError: true, content: parsed.error };
  const prepared = await prepareTarget(parsed, options);
  if ("error" in prepared) return { isError: true, content: prepared.error };
  const { input } = prepared;
  const target = "feature" in input ? input.feature : String(input.pr);
  const summary =
    "feature" in input
      ? `nax ${input.kind} ${target}`
      : `nax bot ${input.kind === "bot_review" ? "review" : "fix"} #${target}`;
  const argv = buildJobArgv(input, options);
  const decision = await options.approve({
    tool: `nax-jobs__${input.kind}`,
    summary,
    command: argv.join(" "),
    reason: await launchReason(prepared, options),
    signal: request.signal,
  });
  if (decision === "deny") {
    return {
      isError: true,
      content: `[chat] the user declined ${summary}; do not retry with different arguments unless the user asks`,
    };
  }
  const job = await options.jobs.start({
    kind: input.kind,
    target,
    argv,
    sessionId: options.sessionId(),
    approvedAt: options.now().toISOString(),
  });
  return {
    content: `${JSON.stringify({ job: job.id, state: "running", log: job.logPath })}\nA [nax-jobs] notice arrives when it ends.`,
  };
}

/** Adapter keeps the launch flow independent of static-provider approval behavior. */
export function launchToolRun(kind: ChatJobKind, options: JobsProviderOptions): ProviderTool["run"] {
  return (raw, ctx) => launchJob({ kind, raw, signal: ctx.signal }, options);
}
