/**
 * The setup decisions `nax bot fix` makes around the install: the one resolve call every path shares
 * and — US-002 — the single retry of a *saved* install that fails, with the install re-resolved from
 * the current base tip, plus the hint the public summary uses to explain a setup failure.
 *
 * It lives beside `fix-run.ts` rather than in it so that module (already the largest of the fix nodes)
 * keeps room under the 600-line source limit. Its collaborators are passed in: the fix's `_deps`
 * object is the seam every test stubs, and importing it here would close a module cycle.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import type { PrRef } from "@/forge";
import { getLogger } from "@/logger";
import { botChecksExtractOp } from "@/operations";
import type { runPreRunSteps } from "../execution/lifecycle/pre-run-steps";
import type { PrStepContext } from "../workflow/branch-step-context";
import { safeCode } from "../workflow/pr-body-safe";
import { _workflowDeps } from "../workflow/step-context";
import type { PrCheckout } from "./checkout";
import type { BotChecks, resolveBotChecks } from "./checks";
import { runBotInstall, withRanSteps } from "./install";
import type { BotReviewArtifact } from "./post";

const PRE_RUN_FAILED = "PRE_RUN_FAILED";

/** The two collaborators the setup paths reach through the fix's own deps object. */
export interface FixSetupDeps {
  readonly resolveBotChecks: typeof resolveBotChecks;
  readonly runPreRunSteps: typeof runPreRunSteps;
}

/** The fix env fields the resolve reads — never the whole env, so a test can build it. */
export interface FixChecksEnv {
  readonly repoRoot: string;
  readonly checkout: PrCheckout;
  readonly config: NaxConfig;
  readonly ctx: PrStepContext;
}

/** The resolve's fields plus the two the re-resolve reports against. */
export interface FixSetupEnv extends FixChecksEnv {
  readonly ref: PrRef;
  readonly review: BotReviewArtifact;
}

/** `preRun` from the head's saved review, or `undefined` when the review did not save any (US-002). */
export function savedFixChecks(review: BotReviewArtifact): BotChecks | undefined {
  return review.version >= 2 && review.checks != null ? review.checks : undefined;
}

/**
 * The checks the trusted base resolves to. `fixChecks` and US-002's re-resolve both call this, so an
 * instruction-tier extraction is billed to this run exactly as the initial resolve was.
 */
export async function resolveFixChecks(
  env: FixChecksEnv,
  deps: Pick<FixSetupDeps, "resolveBotChecks">,
): Promise<BotChecks> {
  const { repoRoot, checkout, config, ctx } = env;
  return deps.resolveBotChecks({
    repoRoot,
    baseSha: checkout.baseSha,
    snapshotDir: checkout.snapshotDir,
    hasBaseNax: checkout.hasBaseNax,
    config,
    extract: (input) =>
      _workflowDeps.callOp(ctx.callCtx, botChecksExtractOp, {
        ...input,
        model: config.bot?.models.checks,
      }),
  });
}

function commandsOf(checks: BotChecks): string[] {
  return checks.preRun.map((step) => step.command);
}

/**
 * The install re-resolved from the base tip, when it is worth a second attempt: a non-empty `preRun`
 * whose commands differ from the saved ones. A resolve that rejects is logged and answers `undefined`
 * — the run ends on the saved command rather than failing the command itself.
 */
async function freshInstall(
  env: FixSetupEnv,
  saved: BotChecks,
  deps: Pick<FixSetupDeps, "resolveBotChecks">,
): Promise<BotChecks | undefined> {
  let fresh: BotChecks;
  try {
    fresh = await resolveFixChecks(env, deps);
  } catch (error) {
    getLogger()?.error("bot-fix", "Could not re-resolve the saved checks from the base tip", {
      pr: env.ref.number,
      error: errorMessage(error),
    });
    return undefined;
  }
  if (fresh.preRun.length === 0) return undefined;
  const savedCommands = commandsOf(saved);
  const freshCommands = commandsOf(fresh);
  if (savedCommands.join("\n") === freshCommands.join("\n")) return undefined;
  getLogger()?.info("bot-fix", "Saved install failed; retrying with the install resolved from the base tip", {
    pr: env.ref.number,
    saved: savedCommands,
    fresh: freshCommands,
  });
  return fresh;
}

export type SavedInstallRetry =
  | { readonly kind: "ran"; readonly checks: BotChecks }
  | { readonly kind: "failed"; readonly checks: BotChecks; readonly error: NaxError }
  | { readonly kind: "none" };

/**
 * US-002: retry a failed *saved* install once, with the install the current base tip resolves. The
 * gates stay the ones the head's review saved — they were reviewed, and re-resolving them is out of
 * scope (#3027) — while the install, its fallbacks and what `ran` all come from the fresh resolve.
 */
export async function retrySavedInstall(input: {
  readonly env: FixSetupEnv;
  readonly deps: FixSetupDeps;
}): Promise<SavedInstallRetry> {
  const { env, deps } = input;
  const saved = savedFixChecks(env.review);
  if (saved === undefined) return { kind: "none" };
  const fresh = await freshInstall(env, saved, deps);
  if (fresh === undefined) return { kind: "none" };
  const attempt: BotChecks = {
    source: saved.source,
    gates: saved.gates,
    preRun: fresh.preRun,
    ...(fresh.install === undefined ? {} : { install: fresh.install }),
  };
  try {
    const { ran } = await runBotInstall(attempt, env.checkout.worktree, deps.runPreRunSteps);
    return { kind: "ran", checks: withRanSteps(attempt, ran) };
  } catch (error) {
    if (!(error instanceof NaxError) || error.code !== PRE_RUN_FAILED) throw error;
    return { kind: "failed", checks: attempt, error };
  }
}

/** Why the frozen install is the one it is, in the words the public summary uses. */
function derivationSource(checks: BotChecks): string | undefined {
  if (checks.install === undefined) return undefined;
  return checks.install.reason === "package-manager" ? "the packageManager field" : "the first lockfile found";
}

/** The commands the failing install attempted, in order; a non-list is ignored rather than crashed on. */
function triedCommands(error: NaxError): string[] {
  const tried = error.context?.tried;
  return Array.isArray(tried) ? tried.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * US-002: the second line of the public setup-failed sentence — what the install was derived from,
 * what else was tried, and the two ways a reader can choose the install themselves. Every lockfile
 * name and command is a code span, so an unbalanced backtick in a hostile name cannot break the body.
 */
export function buildSetupHint(input: {
  readonly checks: BotChecks;
  readonly error: NaxError;
  readonly pr: number;
}): string {
  const { checks, error, pr } = input;
  const lines: string[] = [];
  const lockfile = checks.install?.lockfile;
  const source = derivationSource(checks);
  if (lockfile !== undefined && source !== undefined)
    lines.push(`The install step was derived from \`${safeCode(lockfile)}\` (${source}) on the base branch.`);
  const alsoTried = triedCommands(error).slice(1);
  if (alsoTried.length > 0)
    lines.push(`Also tried: ${alsoTried.map((command) => `\`${safeCode(command)}\``).join(", ")}.`);
  lines.push(
    `Set execution.preRun in the base branch's .nax/config.json to choose the install step; after it is merged, the next nax bot fix ${pr} re-reads it, or run nax bot review ${pr} to refresh the saved checks.`,
  );
  return lines.join("\n");
}

/** The command a `PRE_RUN_FAILED` names, or the first step the checks asked to run. */
export function failedCommand(error: NaxError, checks: BotChecks): string {
  const command = error.context?.command;
  if (typeof command === "string") return command;
  return checks.preRun[0]?.command ?? "unknown";
}
