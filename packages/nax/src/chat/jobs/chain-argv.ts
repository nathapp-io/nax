import { CHAIN_PR_PLACEHOLDER, type ChainStepKind } from "./chain-types";
import { buildJobArgv, type JobLaunchInput, parseJobInput } from "./job-argv";
import type { ChatJobKind } from "./job-types";

/** Like JobLaunchInput, except a bot step may omit pr. */
export type ChainStepInput =
  | Exclude<JobLaunchInput, { kind: "bot_review" | "bot_fix" }>
  | (Omit<Extract<JobLaunchInput, { kind: "bot_review" }>, "pr"> & { readonly pr?: number })
  | (Omit<Extract<JobLaunchInput, { kind: "bot_fix" }>, "pr"> & { readonly pr?: number });

export const CHAIN_STEP_FIELDS: Readonly<Record<ChainStepKind, readonly string[]>> = {
  plan: ["feature", "spec", "profiles", "repo"],
  // US-001: a chain `run` step may pass the run's own --publish mode.
  run: ["feature", "profiles", "maxCost", "repo", "publish"],
  publish: ["feature", "profiles", "repo"],
  bot_review: ["pr", "profiles", "model", "decisions", "repo"],
  bot_fix: ["pr", "profiles", "model", "trust", "noRereview", "repo"],
  // US-007: the handoff is a `nax-flow__send` call, not a launch — no repo, no check, no profiles.
  handoff: ["feature", "roles", "costCapUsd"],
};
const TEMPORARY_PR = 1;
const BOT_PR_OFFSET = 2;

/** The first key the step kind does not declare, as its refusal; undefined when it declares them all. */
export function chainStepFieldError(kind: ChainStepKind, raw: Record<string, unknown>): string | undefined {
  const allowed = CHAIN_STEP_FIELDS[kind];
  const key = Object.keys(raw).find((candidate) => !allowed.includes(candidate));
  return key === undefined ? undefined : `[chat] unknown field ${key}`;
}

export function parseChainStepInput(
  kind: ChatJobKind,
  raw: Record<string, unknown>,
): ChainStepInput | { readonly error: string } {
  const unknown = chainStepFieldError(kind, raw);
  if (unknown !== undefined) return { error: unknown };
  const missingPr = (kind === "bot_review" || kind === "bot_fix") && raw.pr === undefined;
  const parsed = parseJobInput(kind, missingPr ? { ...raw, pr: TEMPORARY_PR } : raw);
  if (missingPr && !("error" in parsed) && (parsed.kind === "bot_review" || parsed.kind === "bot_fix")) {
    const { pr: _pr, ...input } = parsed;
    return input;
  }
  return parsed;
}

export function buildChainStepArgv(
  input: ChainStepInput & { readonly spec?: string },
  ctx: { readonly naxEntry: readonly string[]; readonly repoRoot: string },
): readonly string[] {
  if (input.kind === "plan" || input.kind === "run" || input.kind === "publish") return buildJobArgv(input, ctx);
  const argv = buildJobArgv({ ...input, pr: input.pr ?? TEMPORARY_PR }, ctx);
  if (input.pr !== undefined) return argv;
  return argv.map((token, index) => (index === ctx.naxEntry.length + BOT_PR_OFFSET ? CHAIN_PR_PLACEHOLDER : token));
}

/** Resolve only the designated PR token; never substitute other placeholder-looking arguments. */
export function resolveStepArgv(argv: readonly string[], prIndex: number | undefined, pr?: number): readonly string[] {
  if (prIndex === undefined || pr === undefined) return argv;
  return argv.map((token, index) => (index === prIndex ? String(pr) : token));
}
