import { isAbsolute, win32 } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { validateFeatureName } from "@/utils/feature-name";
import type { ChatJobKind } from "./job-types";

export type JobLaunchInput =
  | { readonly kind: "plan"; readonly feature: string; readonly spec?: string; readonly profiles: readonly string[] }
  | {
      readonly kind: "run";
      readonly feature: string;
      readonly profiles: readonly string[];
      readonly maxIterations?: number;
      readonly maxCost?: number;
    }
  | {
      readonly kind: "bot_review";
      readonly pr: number;
      readonly profiles: readonly string[];
      readonly model?: string;
      readonly decisions?: string;
    }
  | {
      readonly kind: "bot_fix";
      readonly pr: number;
      readonly profiles: readonly string[];
      readonly model?: string;
      readonly trust?: boolean;
      readonly noRereview?: boolean;
    };

type InputError = { readonly error: string };
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_ITERATIONS = 1_000;

function parseProfiles(raw: unknown): readonly string[] | InputError {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== "string")) {
    return { error: "[chat] profiles must be an array of strings" };
  }
  const profiles: string[] = [];
  for (const profile of raw) {
    if (!PROFILE_PATTERN.test(profile)) return { error: `[chat] profile ${profile} is not a valid profile name` };
    profiles.push(profile);
  }
  return profiles;
}

function validRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !value.startsWith("-") &&
    !value.split(/[\\/]/).includes("..")
  );
}

function parsePlan(
  feature: string,
  raw: Record<string, unknown>,
  profiles: readonly string[],
): JobLaunchInput | InputError {
  if (raw.spec === undefined) return { kind: "plan", feature, profiles };
  if (!validRelativePath(raw.spec)) return { error: "[chat] spec must be a repo-relative path" };
  return { kind: "plan", feature, profiles, spec: raw.spec };
}

function parseRun(
  feature: string,
  raw: Record<string, unknown>,
  profiles: readonly string[],
): JobLaunchInput | InputError {
  const { maxIterations, maxCost } = raw;
  if (
    maxIterations !== undefined &&
    (typeof maxIterations !== "number" ||
      !Number.isInteger(maxIterations) ||
      maxIterations < 1 ||
      maxIterations > MAX_ITERATIONS)
  ) {
    return { error: "[chat] maxIterations must be an integer from 1 to 1000" };
  }
  if (maxCost !== undefined && (typeof maxCost !== "number" || !Number.isFinite(maxCost) || maxCost <= 0)) {
    return { error: "[chat] maxCost must be a positive number" };
  }
  return {
    kind: "run",
    feature,
    profiles,
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxCost === undefined ? {} : { maxCost }),
  };
}

function parseBot(
  kind: "bot_review" | "bot_fix",
  raw: Record<string, unknown>,
  profiles: readonly string[],
): JobLaunchInput | InputError {
  const pr = typeof raw.pr === "string" && /^\d+$/.test(raw.pr) ? Number(raw.pr) : raw.pr;
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr <= 0) {
    return { error: "[chat] pr must be a positive integer" };
  }
  const { model } = raw;
  if (model !== undefined && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
    return { error: `[chat] model ${String(model)} is not a valid model id` };
  }
  const base = { pr, profiles, ...(model === undefined ? {} : { model }) };
  if (kind === "bot_review") {
    if (raw.decisions === undefined) return { kind, ...base };
    if (!validRelativePath(raw.decisions)) return { error: "[chat] decisions must be a repo-relative path" };
    return { kind, ...base, decisions: raw.decisions };
  }
  const { trust, noRereview } = raw;
  if (trust !== undefined && typeof trust !== "boolean") return { error: "[chat] trust must be a boolean" };
  if (noRereview !== undefined && typeof noRereview !== "boolean")
    return { error: "[chat] noRereview must be a boolean" };
  return {
    kind,
    ...base,
    ...(trust === undefined ? {} : { trust }),
    ...(noRereview === undefined ? {} : { noRereview }),
  };
}

/** Validates feature names only; target existence and featureDir checks belong to jobs-launch. */
export function parseJobInput(kind: ChatJobKind, raw: Record<string, unknown>): JobLaunchInput | InputError {
  if (kind === "plan" || kind === "run") {
    if (typeof raw.feature !== "string") return { error: "[chat] feature must be a string" };
    try {
      validateFeatureName(raw.feature);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    const profiles = parseProfiles(raw.profiles);
    if ("error" in profiles) return profiles;
    return kind === "plan" ? parsePlan(raw.feature, raw, profiles) : parseRun(raw.feature, raw, profiles);
  }
  const profiles = parseProfiles(raw.profiles);
  if ("error" in profiles) return profiles;
  return parseBot(kind, raw, profiles);
}

/** Callers must resolve a repo-relative plan spec before building argv. No shell or file access. */
export function buildJobArgv(
  input: JobLaunchInput & { readonly spec?: string },
  ctx: { readonly naxEntry: readonly string[]; readonly repoRoot: string },
): readonly string[] {
  const profiles = input.profiles.flatMap((profile) => ["--profile", profile]);
  if (input.kind === "plan") {
    if (input.spec === undefined) {
      throw new NaxError("[chat] plan spec must be resolved before building argv", "CHAT_JOB_SPEC_UNRESOLVED", {
        stage: "chat",
      });
    }
    return [...ctx.naxEntry, "plan", "-f", input.feature, "--from", input.spec, "-d", ctx.repoRoot, ...profiles];
  }
  if (input.kind === "run") {
    return [
      ...ctx.naxEntry,
      "run",
      "-f",
      input.feature,
      "-d",
      ctx.repoRoot,
      "--headless",
      ...profiles,
      ...(input.maxIterations === undefined ? [] : ["-m", String(input.maxIterations)]),
      ...(input.maxCost === undefined ? [] : ["--max-cost", String(input.maxCost)]),
    ];
  }
  return [
    ...ctx.naxEntry,
    "bot",
    input.kind === "bot_review" ? "review" : "fix",
    String(input.pr),
    "-d",
    ctx.repoRoot,
    ...profiles,
    ...(input.model === undefined ? [] : ["--model", input.model]),
    ...(input.kind === "bot_review" && input.decisions !== undefined ? ["--decisions", input.decisions] : []),
    ...(input.kind === "bot_fix" && input.trust === true ? ["--trust"] : []),
    ...(input.kind === "bot_fix" && input.noRereview === true ? ["--no-rereview"] : []),
  ];
}
