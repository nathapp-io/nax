/**
 * The bot's own unsettled blocking finding threads (spec bot-convergence-facts US-008).
 *
 * `nax workflow status` counts the PR's item index, and a bot review finding is never in it: nothing
 * indexes one. So a PR held by three Important finding threads printed `No open items.` (#2981).
 *
 * This reader answers the same question readiness does, with the same parts: `readSettledKeys` — the
 * reader that lifts a readiness hold — decides settlement, `effectiveBlockingTriggers` supplies the set
 * a writer scope ruling can widen or narrow, and `isBlockingFinding` decides severity and class. Status
 * and readiness can therefore not disagree about what still holds the PR.
 *
 * Read-only. Nothing here writes to the forge or to the PR, and a thread with no marker key or a
 * foreign opener is not a finding at all. Resolution is not read here: the shared settlement reader
 * owns that question, and it keeps a resolved finding a writer has since reconfirmed open.
 */
import {
  type ForgeDeps,
  hasWriteAccess,
  NAX_BOT_HEADER,
  type PrComment,
  type PrRef,
  type PrThread,
  parseNaxBotMarker,
  stripNaxBotMarkers,
} from "@/forge";
import { getLogger } from "@/logger";
import {
  type EffectiveBlockingTriggers,
  effectiveBlockingTriggers,
  type FindingTrigger,
  firstIssueLine,
  isBlockingFinding,
  readFindingThreadFacts,
} from "@/workflow/blocking-findings";
import type { OpenItem } from "@/workflow/types";
import { readSettledKeys } from "./rulings";
import { readWriters, writerCheck } from "./writers";

export interface BlockingFindingThreadsInput {
  readonly ref: PrRef;
  readonly threads: readonly PrThread[];
  readonly comments: readonly PrComment[];
  readonly login: string;
  /** `bot.blockingTriggers`, or whatever the config resolved to. */
  readonly configured: readonly FindingTrigger[];
  readonly deps: ForgeDeps;
  readonly cwd: string;
}

export const _blockingThreadsDeps = {
  hasWriteAccess,
  readSettledKeys,
  getLogger,
};

/** A review finding's marker key starts `f-`; a workflow item's starts `w-`, and a thread reply's `t-`. */
const FINDING_KEY_PREFIX = "f-";

/**
 * The finding's own text. `withNaxBotMarker` prepends a visible header and appends the identity marker,
 * and neither is what the finding says: the severity label leads the body, so both have to go before
 * the label can be read.
 */
function findingText(body: string): string {
  return stripNaxBotMarkers(body)
    .split("\n")
    .filter((line) => line.trim() !== NAX_BOT_HEADER)
    .join("\n")
    .trim();
}

interface OwnFindingThread {
  readonly key: string;
  readonly thread: PrThread;
  /** The first comment's body without the bot's own header and marker. */
  readonly text: string;
}

/**
 * Own threads whose first comment carries an `f-` marker key. Ownership is the author, never the
 * marker: a marker is what this bot writes, not who wrote it. A resolved thread is NOT skipped here —
 * the settlement reader decides whether resolution closed the finding, and it deliberately keeps one a
 * writer has since reconfirmed. Filtering on `resolved` would let status and readiness disagree.
 */
function ownFindingThreads(threads: readonly PrThread[], login: string): OwnFindingThread[] {
  return threads.flatMap((thread) => {
    const first = thread.comments[0];
    if (first === undefined || first.author !== login) return [];
    const key = parseNaxBotMarker(first.body)?.key;
    if (key === undefined || !key.startsWith(FINDING_KEY_PREFIX)) return [];
    return [{ key, thread, text: findingText(first.body) }];
  });
}

/** The permission reader, warned once per login when the forge cannot answer. */
function permissionCheck(input: BlockingFindingThreadsInput) {
  return writerCheck(
    { ref: input.ref, deps: input.deps, cwd: input.cwd },
    (...args) => _blockingThreadsDeps.hasWriteAccess(...args),
    (login, error) =>
      _blockingThreadsDeps.getLogger()?.warn("bot-blocking-threads", "Could not check finding-thread permission", {
        login,
        error,
      }),
  );
}

/** Only a top-level PR comment can rule the scope, so only those need a permission answer. */
function rulingComments(comments: readonly PrComment[]): PrComment[] {
  return comments.filter((comment) => comment.kind === "comment");
}

function toOpenItem({ key, thread, text }: OwnFindingThread): OpenItem {
  return {
    id: key,
    kind: "finding",
    severity: readFindingThreadFacts(text).severity,
    ...(thread.path === undefined ? {} : { file: thread.path }),
    ...(thread.line === undefined ? {} : { line: thread.line }),
    issue: `bot review: ${firstIssueLine(text)}`,
  };
}

/**
 * Every own, unresolved, unsettled finding thread that blocks under the PR's effective set, as the open
 * items `nax workflow status` appends to the index's own. The read costs one settlement read and one
 * permission answer per ruling-comment author; a PR with no own finding thread costs neither.
 */
export async function readBlockingFindingThreads(input: BlockingFindingThreadsInput): Promise<readonly OpenItem[]> {
  const candidates = ownFindingThreads(input.threads, input.login);
  if (candidates.length === 0) return [];
  const [settled, writers] = await Promise.all([
    _blockingThreadsDeps.readSettledKeys({
      ref: input.ref,
      login: input.login,
      threads: input.threads,
      comments: input.comments,
      deps: input.deps,
      cwd: input.cwd,
    }),
    readWriters(rulingComments(input.comments), permissionCheck(input)),
  ]);
  const effective: EffectiveBlockingTriggers = effectiveBlockingTriggers({
    comments: input.comments,
    writers,
    configured: input.configured,
  });
  return candidates
    .filter(({ key, text }) => !settled.has(key) && isBlockingFinding(readFindingThreadFacts(text), effective.triggers))
    .map(toOpenItem);
}
