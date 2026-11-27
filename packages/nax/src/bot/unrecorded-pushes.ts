/**
 * nax#3069: ledger-shaped entries for fix pushes `nax bot fix` did not make.
 *
 * Origin, lineage, the fix-gap rule and the chain hold all read the bot's push ledger, which only
 * `nax bot fix` writes. A finding answered from an agent session or by hand leaves no entry, so every
 * later finding on those lines reads as the pull request's own change. This derives an entry for each
 * non-merge commit after the reviewed head that the ledger does not cover and that changes a file
 * holding a finding still open at that review. Its items are those findings, at the generation their
 * threads state. The entry is marked `unrecorded`, so every fact that names it says it was not a
 * `nax bot fix` push.
 *
 * A git failure derives nothing, which is the behaviour before this module existed.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { type PrThread, parseNaxBotMarker, stripNaxBotMarkers } from "@/forge";
import { getSafeLogger } from "@/logger";
import { botGit } from "./git";
import type { BotPushEntry } from "./push-ledger";

/** A finding still open at the reviewed head: its key, the file it is on and its generation. */
export interface OpenFinding {
  readonly key: string;
  readonly path: string;
  readonly issue: string;
  readonly generation: number;
}

export interface UnrecordedPushDeps {
  readonly runGit: (args: string[], cwd: string) => Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

export const _unrecordedPushDeps: { runGit: UnrecordedPushDeps["runGit"] } = {
  runGit: (args, cwd) => botGit(args, cwd),
};

const GENERATION_LINE = /^Lineage: generation (\d+)\b/m;
const HEADER = "**nax bot**";
/** An item names one finding; the same budget the ledger gives its issue text. */
const MAX_ISSUE_CHARS = 120;

function issueOf(body: string): string {
  const text = stripNaxBotMarkers(body).replace(HEADER, "");
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  return first.trim().slice(0, MAX_ISSUE_CHARS);
}

/** The open findings an unrecorded push can answer: threads that carry a nax marker and a path. */
export function openFindings(threads: readonly PrThread[]): readonly OpenFinding[] {
  return threads.flatMap((thread) => {
    const body = thread.comments[0]?.body ?? "";
    const key = parseNaxBotMarker(body)?.key;
    if (key === undefined || thread.path === undefined) return [];
    const generation = Number(GENERATION_LINE.exec(body)?.[1] ?? 0);
    return [{ key, path: thread.path, issue: issueOf(body), generation }];
  });
}

async function git(deps: UnrecordedPushDeps, args: string[], cwd: string): Promise<string> {
  const result = await deps.runGit(args, cwd);
  if (result.exitCode !== 0)
    throw new NaxError("[bot] Cannot read the commits after the reviewed head", "BOT_UNRECORDED_PUSH_GIT", {
      stage: "bot",
      command: args[0],
      exitCode: result.exitCode,
    });
  return result.stdout;
}

/** Every commit a recorded push added on top of its own base. */
async function recordedCommits(
  deps: UnrecordedPushDeps,
  entries: readonly BotPushEntry[],
  cwd: string,
): Promise<ReadonlySet<string>> {
  const shas = new Set<string>();
  for (const entry of entries)
    for (const sha of (await git(deps, ["rev-list", `${entry.base}..${entry.sha}`], cwd)).split("\n"))
      if (sha !== "") shas.add(sha);
  return shas;
}

export interface UnrecordedPushInput {
  readonly worktree: string;
  readonly rangeBase: string;
  readonly head: string;
  readonly recorded: readonly BotPushEntry[];
  readonly open: readonly OpenFinding[];
}

async function derive(input: UnrecordedPushInput, deps: UnrecordedPushDeps): Promise<readonly BotPushEntry[]> {
  const range = `${input.rangeBase}..${input.head}`;
  const commits = (await git(deps, ["rev-list", "--no-merges", "--reverse", "--parents", range], input.worktree))
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([sha, parent]) => sha !== undefined && sha !== "" && parent !== undefined);
  const recorded = await recordedCommits(deps, input.recorded, input.worktree);
  const entries: BotPushEntry[] = [];
  for (const [sha = "", base = ""] of commits) {
    if (recorded.has(sha)) continue;
    const changed = new Set(
      (await git(deps, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha], input.worktree)).split("\0"),
    );
    const items = input.open
      .filter(({ path }) => changed.has(path))
      .map(({ key, generation, issue }) => ({ key, generation, issue }));
    if (items.length > 0) entries.push({ base, sha, at: "", unrecorded: true, items });
  }
  return entries;
}

/** Derived entries for the unrecorded fix pushes in `rangeBase..head`; empty when git cannot say. */
export async function unrecordedPushes(
  input: UnrecordedPushInput,
  deps: UnrecordedPushDeps = _unrecordedPushDeps,
): Promise<readonly BotPushEntry[]> {
  if (input.open.length === 0) return [];
  try {
    return await derive(input, deps);
  } catch (error) {
    getSafeLogger()?.warn("bot", "Could not read the commits after the reviewed head; no unrecorded pushes", {
      storyId: "_run",
      error: errorMessage(error),
    });
    return [];
  }
}
