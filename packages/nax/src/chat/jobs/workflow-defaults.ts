/**
 * How `chat.workflow` supplies a launch's profiles and a bot step's model, and where the
 * card says a value came from (US-006, nax#2931).
 *
 * Pure: the request wins, an empty configured list means "not set", and a launch that names
 * no profiles at all keeps the caller's existing fallback (the PRD's planned profile for a
 * run). Nothing here mutates its input.
 */
import type { ChatWorkflowConfig } from "@/config";
import { listProfiles } from "@/config";
import type { ChatJobKind } from "./job-types";

export interface WorkflowDefaultsApplied<T> {
  readonly input: T;
  /** e.g. "chat.workflow.plan"; present only when profiles came from config. */
  readonly profilesFrom?: string;
  /** e.g. "chat.workflow.botReview"; present only when the model came from config. */
  readonly modelFrom?: string;
}

/** `run` and `finish` share one key: `finish` is a publish-only run. */
type StepKey = "plan" | "run" | "botReview" | "botFix";

interface StepDefaults {
  readonly key: StepKey;
  readonly profiles: readonly string[];
  readonly model?: string;
}

function stepDefaults(workflow: ChatWorkflowConfig, kind: ChatJobKind): StepDefaults {
  switch (kind) {
    case "plan":
      return { key: "plan", profiles: workflow.plan?.profiles ?? [] };
    case "finish":
    case "run":
      return { key: "run", profiles: workflow.run?.profiles ?? [] };
    case "bot_review":
      return { key: "botReview", ...botDefaults(workflow.botReview) };
    case "bot_fix":
      return { key: "botFix", ...botDefaults(workflow.botFix) };
  }
}

function botDefaults(step: { readonly profiles?: readonly string[]; readonly model?: string } | undefined): {
  readonly profiles: readonly string[];
  readonly model?: string;
} {
  return {
    profiles: step?.profiles ?? [],
    ...(step?.model === undefined ? {} : { model: step.model }),
  };
}

/**
 * Lay the configured step defaults under a parsed launch input. Profiles and the bot model
 * are independent: a launch can take its profiles from the request and its model from config.
 */
export function applyWorkflowDefaults<
  T extends { readonly kind: ChatJobKind; readonly profiles: readonly string[]; readonly model?: string },
>(input: T, workflow: ChatWorkflowConfig | undefined): WorkflowDefaultsApplied<T> {
  if (workflow === undefined) return { input };
  const step = stepDefaults(workflow, input.kind);
  const source = `chat.workflow.${step.key}`;
  const fromConfig = input.profiles.length === 0 && step.profiles.length > 0;
  const modelFromConfig = step.model !== undefined && input.model === undefined;
  // The spread of a generic widens it; the shape is unchanged.
  const next = {
    ...input,
    ...(fromConfig ? { profiles: step.profiles } : {}),
    ...(modelFromConfig ? { model: step.model } : {}),
  } as T;
  return {
    input: next,
    ...(fromConfig ? { profilesFrom: source } : {}),
    ...(modelFromConfig ? { modelFrom: source } : {}),
  };
}

/**
 * Separate from `_jobsProviderDeps.listProfileNames` (which stays for `nax-jobs__list`); same
 * body. A leaf dep keeps `jobs-launch.ts` off a value import from `jobs-provider.ts`.
 */
export const _workflowDefaultsDeps: { listProfileNames: (repoRoot: string) => Promise<readonly string[]> } = {
  /** Global and project profile names, deduplicated and sorted; what a launch's `profiles` may name. */
  listProfileNames: async (repoRoot: string): Promise<readonly string[]> =>
    [...new Set((await listProfiles(repoRoot)).map((entry) => entry.name))].sort(),
};

/**
 * The first profile config supplied that this repo does not know, as an agent-facing error.
 * Undefined when the request named its own profiles (explicit names keep the old behaviour) or
 * when every configured name is known.
 */
export async function unknownWorkflowProfile(
  applied: WorkflowDefaultsApplied<{ readonly profiles: readonly string[] }>,
  repoRoot: string,
): Promise<string | undefined> {
  const { profilesFrom } = applied;
  if (profilesFrom === undefined) return undefined;
  const known = await _workflowDefaultsDeps.listProfileNames(repoRoot);
  const unknown = applied.input.profiles.find((name) => !known.includes(name));
  if (unknown === undefined) return undefined;
  return `[chat] ${profilesFrom}.profiles names unknown profile ${unknown}; known: ${known.join(", ")}`;
}
