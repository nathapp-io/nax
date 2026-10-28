import { CHAIN_PR_PLACEHOLDER } from "./chain-types";
import { buildJobArgv, type JobLaunchInput, parseJobInput } from "./job-argv";
import type { ChatJobKind } from "./job-types";

/** Like JobLaunchInput, except a bot step may omit pr. */
export type ChainStepInput =
  | Exclude<JobLaunchInput, { kind: "bot_review" | "bot_fix" }>
  | (Omit<Extract<JobLaunchInput, { kind: "bot_review" }>, "pr"> & { readonly pr?: number })
  | (Omit<Extract<JobLaunchInput, { kind: "bot_fix" }>, "pr"> & { readonly pr?: number });

export const CHAIN_STEP_FIELDS: Readonly<Record<ChatJobKind, readonly string[]>> = {
  plan: ["feature", "spec", "profiles"],
  run: ["feature", "profiles", "maxIterations", "maxCost"],
  bot_review: ["pr", "profiles", "model", "decisions"],
  bot_fix: ["pr", "profiles", "model", "trust", "noRereview"],
};
const TEMPORARY_PR = 1;
const BOT_PR_OFFSET = 2;

export function parseChainStepInput(
  kind: ChatJobKind,
  raw: Record<string, unknown>,
): ChainStepInput | { readonly error: string } {
  for (const key of Object.keys(raw)) {
    if (!CHAIN_STEP_FIELDS[kind].includes(key)) return { error: `[chat] unknown field ${key}` };
  }
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
  if (input.kind === "plan" || input.kind === "run") return buildJobArgv(input, ctx);
  const argv = buildJobArgv({ ...input, pr: input.pr ?? TEMPORARY_PR }, ctx);
  if (input.pr !== undefined) return argv;
  return argv.map((token, index) => (index === ctx.naxEntry.length + BOT_PR_OFFSET ? CHAIN_PR_PLACEHOLDER : token));
}

/** Resolve only the designated PR token; never substitute other placeholder-looking arguments. */
export function resolveStepArgv(argv: readonly string[], prIndex: number | undefined, pr?: number): readonly string[] {
  if (prIndex === undefined || pr === undefined) return argv;
  return argv.map((token, index) => (index === prIndex ? String(pr) : token));
}
