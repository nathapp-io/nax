import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import type { loadBotDecisions, runBotFix, runBotReview } from "@/bot";
import { parseProfileList } from "@/config";
import { NaxError } from "@/errors";
import { initLogger } from "@/logger";

export interface BotCliDeps {
  initLogger: (options: Parameters<typeof initLogger>[0]) => void;
  log: (message: string) => void;
  logErr: (message: string) => void;
  exit: (code: number) => void;
  isInteractive: () => boolean;
  runBotReview: typeof runBotReview;
  runBotFix: typeof runBotFix;
  loadBotDecisions: typeof loadBotDecisions;
}

// Load orchestration only on invocation: help stays cheap and the CLI barrel does
// not close a runtime cycle through bot -> workflow -> cli. Fix remains lazy too.
export const _botCliDeps: BotCliDeps = {
  initLogger,
  log: (message) => {
    process.stdout.write(`${message}\n`);
  },
  logErr: (message) => {
    process.stderr.write(`${message}\n`);
  },
  exit: (code) => {
    process.exit(code);
  },
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  runBotReview: async (input) => (await import("@/bot")).runBotReview(input),
  runBotFix: async (input) => (await import("@/bot")).runBotFix(input),
  loadBotDecisions: async (path) => (await import("@/bot")).loadBotDecisions(path),
};

export interface BotReviewOptions {
  readonly pr: string;
  readonly dir: string;
  readonly profile?: string[];
  readonly model?: string;
  readonly decisions?: string;
}

export type BotFixOptions = Omit<BotReviewOptions, "decisions">;
type BotInput = Parameters<typeof runBotFix>[0];
const SHORT_SHA_LENGTH = 7;

/** Normalize inputs inside the shared error boundary before any orchestration. */
async function withBotInput(
  options: BotReviewOptions,
  deps: BotCliDeps,
  action: (input: BotInput) => Promise<number>,
): Promise<number> {
  try {
    const pr = Number(options.pr);
    if (!/^\d+$/.test(options.pr) || !Number.isSafeInteger(pr) || pr <= 0) {
      throw new NaxError("[bot] PR must be a positive integer", "BOT_PR_INVALID", { stage: "bot", pr: options.pr });
    }
    const { parseModelOption } = await import("@/bot");
    const model = options.model === undefined ? undefined : parseModelOption(options.model);
    return await action({
      pr,
      dir: options.dir,
      profiles: parseProfileList(options.profile),
      model,
      interactive: deps.isInteractive(),
    });
  } catch (err) {
    deps.logErr(errorMessage(err));
    return 1;
  }
}

/** Review and fix use identical guarded input/error conventions. */
export async function botReviewCommand(options: BotReviewOptions, deps: BotCliDeps = _botCliDeps): Promise<number> {
  return withBotInput(options, deps, async (input) => {
    const decisions = options.decisions === undefined ? undefined : await deps.loadBotDecisions(options.decisions);
    const result = await deps.runBotReview({ ...input, ...(decisions === undefined ? {} : { decisions }) });
    if (result.outcome !== "posted") {
      deps.logErr(result.reason);
      return 2;
    }
    deps.log(
      `nax bot review: PR #${input.pr} — ${result.inlineFindings} findings posted, ${result.threadsAnswered} threads answered (intent ${result.intent}, quality ${result.quality})`,
    );
    deps.log(`nax bot review: artifact ${result.artifactPath}`);
    if (result.checksSource === "none") {
      deps.logErr("nax bot review: no check commands found on the base branch; nax bot fix will refuse");
    }
    if (result.logPath !== undefined) deps.log(`nax bot review: log ${result.logPath}`);
    return 0;
  });
}

export async function botFixCommand(options: BotFixOptions, deps: BotCliDeps = _botCliDeps): Promise<number> {
  return withBotInput(options, deps, async (input) => {
    const result = await deps.runBotFix(input);
    if (result.outcome !== "pushed" && result.outcome !== "nothing") {
      deps.logErr("reason" in result ? result.reason : result.outcome);
      if (result.logPath !== undefined) deps.log(`nax bot fix: log ${result.logPath}`);
      return 2;
    }
    if (result.outcome === "pushed" && !result.pushedSha) {
      throw new NaxError(`[bot] Missing pushed SHA for PR #${input.pr}`, "BOT_PUSHED_SHA_MISSING", {
        stage: "bot",
        pr: input.pr,
      });
    }
    const summary =
      result.outcome === "nothing" ? "nothing to fix" : `pushed ${result.pushedSha?.slice(0, SHORT_SHA_LENGTH)}`;
    deps.log(`nax bot fix: PR #${input.pr} — ${summary}`);
    if (result.logPath !== undefined) deps.log(`nax bot fix: log ${result.logPath}`);
    return 0;
  });
}

function withBotOptions(command: Command): Command {
  return command
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option(
      "--profile <name>",
      "Config profile (repeatable or comma-separated)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--model <value>", "Model tier or agent:model");
}

/** Register both actions on the existing bot group; help never runs orchestration. */
export function registerBotCommand(program: Command, deps: BotCliDeps = _botCliDeps): Command {
  const group = program.command("bot").description("Review and fix pull requests with nax");
  group.hook("preAction", () => {
    deps.initLogger({ level: "silent", useChalk: false });
  });
  withBotOptions(group.command("review <pr>").description("Review a pull request and post findings"))
    .option("--decisions <path>", "Caller decisions file")
    .action(async (pr: string, options: Omit<BotReviewOptions, "pr">) => {
      deps.exit(await botReviewCommand({ ...options, pr }, deps));
    });
  withBotOptions(group.command("fix <pr>").description("Fix agreed findings and push changes")).action(
    async (pr: string, options: Omit<BotFixOptions, "pr">) => {
      deps.exit(await botFixCommand({ ...options, pr }, deps));
    },
  );
  return group;
}
