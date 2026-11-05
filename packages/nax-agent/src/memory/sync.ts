/**
 * One sync: the guarded lifecycle around the mirror's exchange with a provider.
 *
 * Two guards, because ownership has two shapes. The lock files are the cross-process ones —
 * one for the project mirror and, when the store has a user directory, one for the user mirror
 * every project shares. `acquireSessionLock` classifies the caller's own pid as `own` — it
 * cannot tell a second caller in this process from the first — so a module-level in-flight set
 * keyed by the lock paths is what stops the same process syncing twice at once. Both are taken
 * before the first `await`: a check that yields first is a check two callers pass.
 *
 * `syncMemory` never throws and never rejects. A live holder is `locked`, an
 * unreachable provider is `unreachable`, anything unexpected is `failed` with
 * its message — and the lock and the in-flight key are released on every path,
 * including the failing ones, because a guard left behind is a store that can
 * never sync again. A cleanup that fails is logged, never thrown: it must not
 * turn a reportable outcome into a rejection.
 *
 * Step 2 asks the provider whether it answers, and asks it through
 * `raceTimeout`: an answer that never arrives must not hold the run open, so the
 * probe is bounded by `MEMORY_PROBE_TIMEOUT_MS` on the injected timers. `false`,
 * a throw and a timeout are one outcome — `unreachable` — and it is recorded in
 * `sync.json` over the cursors a failed probe learned nothing about.
 *
 * Step 3 delivers what the agent already wrote. Each `queued` entry is pushed in
 * `seq` order through the same kind of race, and the provider's answer is applied
 * to the mirror before the entry is removed: a `save` carries the returned id and
 * status into its note, a `forget` removes the note only when the provider says it
 * is `deleted`. The two failures are not the same fact. `MEMORY_PUSH_REJECTED` is
 * permanent — retrying would repeat it — so the entry is marked with the reason and
 * the drain continues. Anything else, a timeout included, is transient: the drain
 * stops, the entry stays `queued` for the next run, `sync.json` records why, and
 * the run ends `failed` — after the index is refreshed, so a forget still waiting
 * is visible as `(forget pending)`. One transient kind repeats: a bad response, an
 * answer that arrived but cannot be used (`isMemoryBadResponse`). It is counted on
 * the entry, and the entry that meets `MEMORY_PUSH_MAX_BAD_RESPONSES` of them is
 * parked as `rejected` — but only once the next write for another key is answered,
 * which proves the fault is the entry's and not the provider's. Writes of the same
 * key never overtake it, so per-key `seq` order still holds.
 *
 * Step 4 asks the provider for what changed elsewhere, one page at a time. The cursor
 * each page hands back is checkpointed before the next page is asked for, so the disk
 * always names the last page that arrived: a page that throws, times out or never comes
 * leaves the run resuming there rather than from the beginning. `done` is the provider's
 * answer about the sequence, not a budget, so a sequence that ends on the last page one
 * run may drain has finished; only one with more behind it is a page-limit failure.
 *
 * What a page *means* is decided one entry at a time. A note the schema refuses — a slug
 * outside `MEMORY_SLUG_RE`, a field missing or over its model limit — is skipped and
 * reported once, never thrown: one unreadable entry must not cost the page its cursor. A
 * key the outbox still holds is left exactly as the local mirror has it and is not counted,
 * because the local write is the newer fact. A tombstone deletes. `decisions` replace
 * `decisions.jsonl` on a project page only. The held set is read after each page, and the
 * page's scope — not the payload's `scope` field — decides where a note lands.
 */
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { refreshMemoryIndex } from "./index-render.ts";
import { acquireMirrorLocks, type ReleaseLock, storeLockTargets } from "./mirror-lock.ts";
import { parseMemoryNoteRecord } from "./note.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryPage, MemoryProvider } from "./provider-types.ts";
import type { MemoryStore, MemorySyncState } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, providerAnswers, raceTimeout, warnQuietly } from "./support.ts";
import { drainOutbox, type MemoryParkedEntry } from "./sync-drain.ts";
import { claimSync, releaseSync } from "./sync-flight.ts";
import {
  MEMORY_OP_TIMEOUT_MS,
  MEMORY_PULL_MAX_PAGES,
  MEMORY_PULL_PAGE_SIZE,
  MEMORY_SLUG_RE,
  type MemoryNote,
  type MemoryNoteStatus,
  type MemoryScope,
  type MemoryTimers,
} from "./types.ts";

/** What `sync.json` records when the provider did not answer this run. */
const UNREACHABLE = "unreachable";

/** What `sync.json` records when a provider had more pages than one run may drain. */
const PAGE_LIMIT_REACHED = "pull page limit reached";

/** Everything one sync needs: the mirror, the queue and the provider it talks to. */
export interface MemorySyncInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
  readonly logger: AgentLogger;
  /** The clock the lock protocol stamps with; default `() => new Date()`. */
  readonly now?: () => Date;
  /** The timer seam the step timeouts race against; default the globals. */
  readonly timers?: MemoryTimers;
  /** The pid this process claims in the lock; default `process.pid`. */
  readonly pid?: number;
  /** The liveness probe a lock holder is judged by; default `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
  /** How many notes one pull asks for; default `MEMORY_PULL_PAGE_SIZE`. */
  readonly pageSize?: number;
}

/** What one run did, and how it ended. */
export interface MemorySyncResult {
  readonly outcome: "synced" | "unreachable" | "locked" | "failed";
  readonly pushed: number;
  readonly rejected: number;
  readonly pulled: number;
  readonly skipped: number;
  /** The message of the failure that ended the run, when it ended in one. */
  readonly error?: string;
  /** The entries this run parked; absent when it parked none. They are counted in `rejected`. */
  readonly parked?: readonly MemoryParkedEntry[];
}

/** What a run holds when it took no lock: releasing nothing is releasing successfully. */
const NO_RELEASE: ReleaseLock = async () => undefined;

/** What one run moved: the drain's two counters and the pull's two. */
interface MemorySyncCounts {
  pushed: number;
  rejected: number;
  pulled: number;
  skipped: number;
}

function noCounts(): MemorySyncCounts {
  return { pushed: 0, rejected: 0, pulled: 0, skipped: 0 };
}

/** The `parked` field a result carries: only when the run parked something. */
function parkedField(parked: readonly MemoryParkedEntry[]): Pick<MemorySyncResult, "parked"> {
  return parked.length === 0 ? {} : { parked };
}

/** A run that stopped before it moved anything. */
function stopped(outcome: MemorySyncResult["outcome"], error?: string): MemorySyncResult {
  return { outcome, ...noCounts(), ...(error === undefined ? {} : { error }) };
}

/** The clock a run stamps with: the caller's, or the process clock. */
function clockOf(input: MemorySyncInput): () => Date {
  return input.now ?? (() => new Date());
}

/**
 * Take every lock this store's mirrors need, or `null` when another writer holds one.
 *
 * The set is what a store with a user directory needs: the project's lock alone leaves two
 * projects staging the same user note at once. `acquireMirrorLocks` takes them in the one
 * canonical order, maps a live holder to `null` and hands back what it already took.
 */
async function takeLock(input: MemorySyncInput): Promise<ReleaseLock | null> {
  return await acquireMirrorLocks(input, storeLockTargets(input.store));
}

/**
 * Step 2's failing arm: record why this run could not reach the provider, and stop.
 *
 * Only `lastError` changes — a probe that failed learned nothing about the cursors
 * or the last pull, so whatever the previous sync left carries over untouched — and
 * the outbox is not read, so the queued writes stay exactly as they were.
 */
async function recordUnreachable(input: MemorySyncInput): Promise<MemorySyncResult> {
  await recordLastError(input, UNREACHABLE);
  return stopped("unreachable");
}

/** Note why a run could not finish, leaving every other field of the state as it was. */
async function recordLastError(input: MemorySyncInput, message: string): Promise<void> {
  const state = await input.store.readSyncState();
  await input.store.writeSyncState({ ...state, lastError: message });
}

/** The cursor pair with one scope moved: the other scope's cursor is carried over untouched. */
function cursorWith(
  cursor: MemorySyncState["cursor"],
  scope: MemoryScope,
  next: string | null,
): MemorySyncState["cursor"] {
  return scope === "user" ? { ...cursor, user: next } : { ...cursor, project: next };
}

/**
 * After each page: record where this scope's pull got to.
 *
 * The page is the checkpoint, so it is written before the next one is asked for. A page
 * that throws, times out or never arrives therefore leaves the disk naming the last page
 * that did arrive, and the next run resumes there instead of from the beginning. The
 * `lastError` a previous run left is cleared here: this pull reached the provider.
 */
async function checkpointPull(input: MemorySyncInput, scope: MemoryScope, cursor: string | null): Promise<void> {
  const state = await input.store.readSyncState();
  await input.store.writeSyncState({
    provider: input.provider.id,
    cursor: cursorWith(state.cursor, scope, cursor),
    lastPullAt: clockOf(input)().toISOString(),
    lastError: null,
  });
}

/** The statuses a pull applies as a deletion: the note is retired wherever it came from. */
const TOMBSTONES: ReadonlySet<MemoryNoteStatus> = new Set(["superseded", "rejected", "deleted"]);

/** A pulled entry the mirror may not hold, with the reason it is not one. */
type InvalidEntry = { readonly kind: "invalid"; readonly slug?: string; readonly reason: string };

/** One entry of a page: the note it describes, or why it is not a note a mirror may hold. */
type PulledEntry = { readonly kind: "note"; readonly note: MemoryNote } | InvalidEntry;

/**
 * One entry of a page read as a note the mirror may hold.
 *
 * The slug is checked first, so `Bad Slug` is refused as a slug and not as an opaque shape
 * error; `parseMemoryNoteRecord` is then the schema a mirror read applies, so a pulled note
 * and a stored one are held to one contract. Both refusals are a skip, never a throw.
 */
function readPulledEntry(entry: unknown): PulledEntry {
  const slug = typeof entry === "object" && entry !== null && "slug" in entry ? entry.slug : undefined;
  if (typeof slug !== "string" || !MEMORY_SLUG_RE.test(slug)) {
    const reason = typeof slug === "string" ? `slug "${slug}" is not a valid note slug` : "slug is missing";
    return { kind: "invalid", ...(typeof slug === "string" ? { slug } : {}), reason };
  }
  try {
    return { kind: "note", note: parseMemoryNoteRecord(entry) };
  } catch (error) {
    return { kind: "invalid", slug, reason: errorMessage(error) };
  }
}

/** One entry the mirror could not take: reported once, at warn, naming the scope and the entry. */
function warnInvalidEntry(logger: AgentLogger, scope: MemoryScope, entry: InvalidEntry): void {
  warnQuietly(logger, "skipping a pulled note that is not a valid memory note", {
    scope,
    ...(entry.slug === undefined ? {} : { slug: entry.slug }),
    error: entry.reason,
  });
}

/** What one page moved: the notes stored, and the entries that were not. */
interface PageResult {
  readonly pulled: number;
  readonly skipped: number;
}

/**
 * Step 4's mirror half: one page applied to its scope's mirror.
 *
 * The held set is read here, after the page arrived, not once per run: a write enqueued
 * while the page was in flight is one this page must not overwrite, and the local copy is
 * the newer fact — so a held key is left exactly as the mirror has it, and is not counted,
 * because nothing was skipped: the write is still on its way. The page's scope, not the
 * payload's own `scope` field, says where a note lands. A tombstone deletes rather than
 * counts: a retired note is not a pull. Decisions and the cursor checkpoint follow both.
 */
async function applyPulledPage(input: MemorySyncInput, scope: MemoryScope, answer: MemoryPage): Promise<PageResult> {
  const held = await input.outbox.heldKeys();
  let pulled = 0;
  let skipped = 0;
  for (const entry of answer.notes) {
    const parsed = readPulledEntry(entry);
    if (parsed.kind === "invalid") {
      skipped += 1;
      warnInvalidEntry(input.logger, scope, parsed);
      continue;
    }
    const { note } = parsed;
    if (held.has(`${scope}/${note.slug}`)) continue;
    if (TOMBSTONES.has(note.status)) {
      await input.store.deleteNote(scope, note.slug);
      continue;
    }
    await input.store.writeNote({ ...note, scope });
    pulled += 1;
  }
  // The project mirror owns `decisions.jsonl`: a user page's decisions are not the mirror's to write.
  if (scope === "project" && answer.decisions !== undefined) await input.store.writeDecisions(answer.decisions);
  return { pulled, skipped };
}

/** What a scope's pages came to: what they moved, and the failure that stopped the sequence. */
type PullResult = PageResult & { readonly failure?: string };

/**
 * One scope's pages, one at a time, each checkpointed before the next is asked for.
 *
 * A page fails the pull wherever it goes wrong — the provider not answering, timing out, or
 * the mirror refusing what it carried — and all three leave the cursor at the last page that
 * was applied. Applying a page sits in the same catch as the race so its reason reaches
 * `lastError`, and not only the run's never-throws shell. The limit is a budget on this run,
 * not a claim about the sequence: a page that says `done` finished whatever page it is, so
 * reaching the limit is a failure only when the provider still has more to give.
 */
async function pullScope(input: MemorySyncInput, scope: MemoryScope, timers: MemoryTimers): Promise<PullResult> {
  const take = input.pageSize ?? MEMORY_PULL_PAGE_SIZE;
  let cursor = (await input.store.readSyncState()).cursor[scope];
  let pulled = 0;
  let skipped = 0;
  for (let page = 0; page < MEMORY_PULL_MAX_PAGES; page += 1) {
    try {
      const answer = await raceTimeout(input.provider.pull({ scope, cursor, take }), MEMORY_OP_TIMEOUT_MS, timers);
      const applied = await applyPulledPage(input, scope, answer);
      pulled += applied.pulled;
      skipped += applied.skipped;
      cursor = answer.nextCursor ?? cursor;
      await checkpointPull(input, scope, cursor);
      if (answer.done) return { pulled, skipped };
    } catch (error) {
      return { pulled, skipped, failure: errorMessage(error) };
    }
  }
  return { pulled, skipped, failure: PAGE_LIMIT_REACHED };
}

/** The scopes a run pulls, in order: the project mirror, then the user's when the store has one. */
function pullScopes(store: MemoryStore): readonly MemoryScope[] {
  return store.paths.userDir === null ? ["project"] : ["project", "user"];
}

/**
 * Step 4: ask the provider for every page of every scope.
 *
 * The first failure ends the pull and the other scope is not asked: a cursor that did
 * not advance is where the next run resumes, and reading past it would record progress
 * this run never made.
 */
async function pullAll(input: MemorySyncInput): Promise<PullResult> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  let pulled = 0;
  let skipped = 0;
  for (const scope of pullScopes(input.store)) {
    const result = await pullScope(input, scope, timers);
    pulled += result.pulled;
    skipped += result.skipped;
    if (result.failure !== undefined) return { pulled, skipped, failure: result.failure };
  }
  return { pulled, skipped };
}

/**
 * A run that stopped after it moved something: record why, refresh the index, report failed.
 *
 * The index is still refreshed, because what the run did move is what the next session
 * has to see — a forget left queued renders as `(forget pending)` — and the counters are
 * the work that was done before the step that failed.
 */
async function failRun(
  input: MemorySyncInput,
  counts: MemorySyncCounts,
  parked: readonly MemoryParkedEntry[],
  failure: string,
): Promise<MemorySyncResult> {
  await recordLastError(input, failure);
  return await finish(input, counts, parked, failure);
}

/**
 * Step 5: regenerate the index the next session reads, and report what the run did.
 *
 * `failure` is the step that stopped early, if any: the counters are what did move
 * before it stopped.
 */
async function finish(
  input: MemorySyncInput,
  counts: MemorySyncCounts,
  parked: readonly MemoryParkedEntry[],
  failure?: string,
): Promise<MemorySyncResult> {
  const heldForgets = await input.outbox.heldKeys("forget");
  await refreshMemoryIndex(input.store, { heldForgets });
  const outcome =
    failure === undefined ? { outcome: "synced" as const } : { outcome: "failed" as const, error: failure };
  return { ...outcome, ...counts, ...parkedField(parked) };
}

/** Hand the lock back if this run took it; a failed release is logged, never thrown. */
async function releaseQuietly(input: MemorySyncInput, release: ReleaseLock): Promise<void> {
  try {
    await release();
  } catch (error) {
    warnQuietly(input.logger, "memory sync could not release the lock", {
      path: input.store.paths.lock,
      error: errorMessage(error),
    });
  }
}

export async function syncMemory(input: MemorySyncInput): Promise<MemorySyncResult> {
  const lock = input.store.paths.lock;
  // Every lock this run takes is claimed here, synchronously and before the first await: a
  // guard taken after a yield is one two callers both pass. Nothing has touched the
  // filesystem on this path. Only the claims *this* run won are recorded, so a run that loses
  // contention on the second mirror gives back the first — and never the claim of the sync
  // that is already running, which would let a third caller in behind it.
  const claimed: string[] = [];
  const won = storeLockTargets(input.store).every((target) => {
    if (!claimSync(target.path)) return false;
    claimed.push(target.path);
    return true;
  });
  if (!won) {
    for (const path of claimed) releaseSync(path);
    return stopped("locked");
  }
  let release: ReleaseLock = NO_RELEASE;
  try {
    const acquired = await takeLock(input);
    if (acquired === null) return stopped("locked");
    release = acquired;
    const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
    if (!(await providerAnswers(input.provider, timers))) return await recordUnreachable(input);
    const drain = await drainOutbox(input);
    const counts: MemorySyncCounts = { ...noCounts(), pushed: drain.pushed, rejected: drain.rejected };
    // A drain that stopped early says nothing about the provider's own changes: no pull.
    if (drain.failure !== undefined) return await failRun(input, counts, drain.parked, drain.failure);
    const pull = await pullAll(input);
    counts.pulled = pull.pulled;
    counts.skipped = pull.skipped;
    if (pull.failure !== undefined) return await failRun(input, counts, drain.parked, pull.failure);
    return await finish(input, counts, drain.parked);
  } catch (error) {
    const message = errorMessage(error);
    warnQuietly(input.logger, "memory sync failed", { path: lock, error: message });
    return stopped("failed", message);
  } finally {
    await releaseQuietly(input, release);
    // Cleared whatever the cleanup did: a lock we could not release ages into
    // stale recovery, but this process must not be wedged until then.
    for (const path of claimed) releaseSync(path);
  }
}
