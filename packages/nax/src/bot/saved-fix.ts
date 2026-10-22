/** PR-scoped, best-effort retention of unpushed commits outside disposable checkouts. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";
import { getLogger } from "@/logger";
import { gitWithTimeout } from "@/utils/git";
import type { BotFixEnv, BotFixState } from "./fix-steps";

const SAVABLE_OUTCOMES = [
  "gates-failed",
  "baseline-red",
  "prepare-touched-tracked",
  "push-rejected",
  "push-unknown",
  "cost-limit",
] as const;
const shaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/);
export const SavedFixSchema = z.object({
  version: z.literal(1),
  sha: shaSchema,
  headSha: shaSchema,
  agreedKeys: z.array(z.string()),
  outcome: z.enum(SAVABLE_OUTCOMES),
  savedAt: z.string().datetime(),
});
export type SavedFix = z.infer<typeof SavedFixSchema>;
export interface SavedFixLocation {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly prNumber: number;
}

export const _savedFixDeps = {
  runGit: gitWithTimeout,
  readText: (path: string): Promise<string> => Bun.file(path).text(),
  write: async (path: string, value: string): Promise<void> => {
    await Bun.write(path, value);
  },
  remove: async (path: string): Promise<void> => {
    const file = Bun.file(path);
    if (await file.exists()) await file.delete();
  },
};

function savedFixPath(outputDir: string, prNumber: number): string {
  return join(outputDir, "bot", `pr-${prNumber}`, "saved-fix.json");
}
function savedFixRef(prNumber: number): string {
  return `refs/nax-bot/pr-${prNumber}/fix`;
}
function logFailure(operation: string, prNumber: number, error: unknown): void {
  getLogger()?.warn("bot-fix", `Could not ${operation} saved fix`, { pr: prNumber, error: errorMessage(error) });
}

export async function readSavedFix(outputDir: string, prNumber: number): Promise<SavedFix | null> {
  try {
    return SavedFixSchema.parse(JSON.parse(await _savedFixDeps.readText(savedFixPath(outputDir, prNumber))));
  } catch (error) {
    logFailure("read", prNumber, error);
    return null;
  }
}

export async function saveFix(location: SavedFixLocation, entry: SavedFix): Promise<void> {
  const { repoRoot, outputDir, prNumber } = location;
  try {
    const validated = SavedFixSchema.parse(entry);
    const result = await _savedFixDeps.runGit(["update-ref", savedFixRef(prNumber), validated.sha], repoRoot);
    if (result.exitCode !== 0) {
      logFailure("save ref for", prNumber, result.stderr || `git exited ${result.exitCode}`);
      return;
    }
    await _savedFixDeps.write(savedFixPath(outputDir, prNumber), `${JSON.stringify(validated, null, 2)}\n`);
  } catch (error) {
    logFailure("save", prNumber, error);
  }
}

export async function clearSavedFix(location: SavedFixLocation): Promise<void> {
  const { repoRoot, outputDir, prNumber } = location;
  try {
    const result = await _savedFixDeps.runGit(["update-ref", "-d", savedFixRef(prNumber)], repoRoot);
    if (result.exitCode !== 0) logFailure("clear ref for", prNumber, result.stderr || `git exited ${result.exitCode}`);
  } catch (error) {
    logFailure("clear ref for", prNumber, error);
  }
  try {
    await _savedFixDeps.remove(savedFixPath(outputDir, prNumber));
  } catch (error) {
    logFailure("clear file for", prNumber, error);
  }
}

async function savedSha(env: BotFixEnv, state: BotFixState): Promise<string | undefined> {
  if (state.outcome === "prepare-touched-tracked") return state.fixSha;
  const result = await _savedFixDeps.runGit(["rev-parse", "HEAD"], env.checkout.worktree);
  if (result.exitCode !== 0) {
    logFailure("read HEAD for", env.ref.number, result.stderr || `git exited ${result.exitCode}`);
    return undefined;
  }
  const head = result.stdout.trim();
  return head === env.info.headSha ? state.fixSha : head;
}

/** Called only after the graph, while its checkout and logger are still alive. */
export async function persistSavedFix(input: {
  env: BotFixEnv;
  state: BotFixState;
  outputDir: string;
  savedFix: { save: typeof saveFix };
}): Promise<void> {
  const { env, state, outputDir, savedFix } = input;
  const outcome = SavedFixSchema.shape.outcome.safeParse(state.outcome);
  if (!outcome.success || !state.fixSha || state.fixSha === env.info.headSha) return;
  try {
    const sha = await savedSha(env, state);
    if (!sha) return;
    await savedFix.save(
      { repoRoot: env.repoRoot, outputDir, prNumber: env.ref.number },
      {
        version: 1,
        sha,
        headSha: env.info.headSha,
        agreedKeys: env.review.agreed.map((item) => item.key).sort(),
        outcome: outcome.data,
        savedAt: new Date().toISOString(),
      },
    );
  } catch (error) {
    logFailure("persist", env.ref.number, error);
  }
}
