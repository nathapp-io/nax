import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import type { runBotFix, runBotReview } from "@/bot";
import { parseProfileList } from "@/config";
import { NaxError } from "@/errors";

export interface BotCliDeps {
  log: (message: string) => void;
  logErr: (message: string) => void;
  exit: (code: number) => void;
  isInteractive: () => boolean;
  runBotReview: typeof runBotReview;
  runBotFix: typeof runBotFix;
}

// Load orchestration only on invocation: help stays cheap and the CLI barrel does
// not close a runtime cycle through bot -> workflow -> cli. Fix remains lazy too.
export const _botCliDeps: BotCliDeps = {
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
};

export interface BotReviewOptions {
  readonly pr: string;
  readonly dir: string;
  readonly profile?: string[];
  readonly model?: string;
}

/** Normalize inputs before orchestration, and keep diagnostics off stdout. */
export async function botReviewCommand(options: BotReviewOptions, deps: BotCliDeps = _botCliDeps): Promise<number> {
  try {
    const pr = Number(options.pr);
    if (!/^\d+$/.test(options.pr) || !Number.isSafeInteger(pr) || pr <= 0) {
      throw new NaxError("[bot] PR must be a positive integer", "BOT_PR_INVALID", { stage: "bot", pr: options.pr });
    }
    const { parseModelOption } = await import("@/bot");
    const model = options.model === undefined ? undefined : parseModelOption(options.model);
    const result = await deps.runBotReview({
      pr,
      dir: options.dir,
      profiles: parseProfileList(options.profile),
      model,
      interactive: deps.isInteractive(),
    });
    if (result.outcome !== "posted") {
      deps.logErr(result.reason);
      return 2;
    }
    deps.log(
      `nax bot review: PR #${pr} — ${result.inlineFindings} findings posted, ${result.threadsAnswered} threads answered (intent ${result.intent}, quality ${result.quality})`,
    );
    return 0;
  } catch (err) {
    deps.logErr(errorMessage(err));
    return 1;
  }
}

/** Register review only; the fix action is added by US-020. */
export function registerBotCommand(program: Command, deps: BotCliDeps = _botCliDeps): Command {
  const group = program.command("bot").description("Review pull requests with nax");
  group
    .command("review <pr>")
    .description("Review a pull request and post findings")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option(
      "--profile <name>",
      "Config profile (repeatable or comma-separated)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--model <value>", "Model tier or agent:model")
    .action(async (pr: string, options: Omit<BotReviewOptions, "pr">) => {
      const code = await botReviewCommand({ ...options, pr }, deps);
      deps.exit(code);
    });
  return group;
}
