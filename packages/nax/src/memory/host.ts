/**
 * The memory host: the object every memory surface reads through.
 *
 * A host is pure composition. It resolves the mirror directories once, builds
 * the store, the outbox and the local provider over them, and then answers every
 * read from that composition — the mirror's notes merged with the repository's
 * committed team notes. Nothing is cached: each call re-reads the mirror and the
 * repository, so a note a teammate commits mid-session, or one another nax
 * process saves, is visible on the next call rather than after a restart.
 *
 * A repo note never shadows the agent's own: `notes("project")` holds every
 * mirror note, and from the repository only the slugs the mirror does not
 * already hold. That is the merge the surface sees — one note per slug, the
 * mirror's, and the team's note stays reachable in the repository.
 *
 * The repository is untrusted input, and its notes are re-read on every call, so
 * the host hands `readRepoNotes` a wrapper of its logger that drops a warn it has
 * already passed on. One committed file that breaks a rule then warns once per
 * host instead of once per read, without the host having to remember which files
 * it rejected.
 *
 * The index and the status are compositions too, over that same set: the index is
 * feature 1's renderer given both scopes, the project's decisions, the notes with
 * a forget still queued and this project's byte cap, and the status is the counts
 * of what the mirror, the repository and the outbox hold. Neither caches, so a
 * read of either costs one re-read of the repository.
 *
 * Sync is the one operation that is not a read: it hands the same composition to
 * feature 1's `syncMemory`, which owns the lock, the drain and the pull, and never
 * throws — so this host reports what it returns rather than guarding it.
 *
 * The writes are composed from that same composition plus the one read they need
 * (`host-writes.ts`): a save is feature 1's operation stamped with this host's
 * write mode and source, and a forget or an approve is the same operation behind
 * the refusal that leaves a note only the repository holds untouched.
 */
import {
  approveMemoryNote,
  createLocalMemoryProvider,
  createMemoryOutbox,
  createMemoryStore,
  forgetMemoryNote,
  type MemoryForgetResult,
  type MemoryHit,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryProvider,
  type MemorySaveResult,
  type MemoryScope,
  type MemoryStore,
  type MemorySyncResult,
  type RenderedMemoryIndex,
  renderMemoryIndex,
  saveMemoryNote,
  searchMemoryNotes,
  syncMemory,
} from "@nathapp/nax-agent";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { type MemoryConfig, memoryConfigOf, type NaxConfig } from "@/config";
import { createHostWrites } from "./host-writes";
import { type MemoryDirs, type MemoryLogger, memoryDirs } from "./paths";
import { type RepoNotes, readRepoNotes } from "./repo-notes";

/** What a caller needs to know about a host without calling one of its reads. */
export interface MemoryStatus {
  readonly enabled: true;
  readonly provider: string;
  readonly writeMode: "direct" | "proposal";
  readonly projectDir: string;
  readonly userDir: string;
  readonly lastPullAt: string | null;
  readonly lastError: string | null;
  readonly queued: number;
  readonly rejected: number;
  readonly notes: { readonly project: number; readonly user: number; readonly repo: number };
  readonly repoSkipped: number;
}

/** One keyword search: the words, the scopes to look in, and how many hits to keep. */
export interface MemorySearchInput {
  readonly text: string;
  readonly scope?: MemoryScope;
  readonly limit: number;
}

/** The memory surface every consumer (chat, runs, the CLI) reads and writes through. */
export interface MemoryHost {
  readonly dirs: MemoryDirs;
  readonly providerId: string;
  readonly writeMode: "direct" | "proposal";
  notes(scope: MemoryScope): Promise<readonly MemoryNote[]>;
  getNote(scope: MemoryScope, slug: string): Promise<MemoryNote | null>;
  search(input: MemorySearchInput): Promise<readonly MemoryHit[]>;
  renderIndex(): Promise<RenderedMemoryIndex>;
  sync(): Promise<MemorySyncResult>;
  status(): Promise<MemoryStatus>;
  save(write: MemoryNoteWrite): Promise<MemorySaveResult>;
  forget(input: {
    readonly scope: MemoryScope;
    readonly slug: string;
    readonly reason: string;
  }): Promise<MemoryForgetResult>;
  approve(input: { readonly scope: MemoryScope; readonly slug: string }): Promise<MemoryNote>;
}

/** What `createMemoryHost` is given by the surface that opens the session. */
export interface CreateMemoryHostInput {
  readonly config: NaxConfig;
  readonly repoRoot: string;
  /** The label a note this host writes records as its origin. */
  readonly source: string;
  readonly logger: MemoryLogger;
}

/**
 * Composition seam for tests. Every part of the host is built through here, so a
 * test can drive a failing or disabled path without a mirror on disk.
 */
export const _memoryHostDeps: {
  memoryDirs: typeof memoryDirs;
  readRepoNotes: typeof readRepoNotes;
  createMemoryStore: typeof createMemoryStore;
  createMemoryOutbox: typeof createMemoryOutbox;
  createLocalMemoryProvider: typeof createLocalMemoryProvider;
  syncMemory: typeof syncMemory;
  saveMemoryNote: typeof saveMemoryNote;
  forgetMemoryNote: typeof forgetMemoryNote;
  approveMemoryNote: typeof approveMemoryNote;
} = {
  memoryDirs,
  readRepoNotes,
  createMemoryStore,
  createMemoryOutbox,
  createLocalMemoryProvider,
  syncMemory,
  saveMemoryNote,
  forgetMemoryNote,
  approveMemoryNote,
};

/** The parts one host is composed from: the mirror, its queue and the provider behind it. */
interface MemoryParts {
  readonly dirs: MemoryDirs;
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
}

/** Slug order, as code points: the one order every note listing is served in. */
function bySlug(left: MemoryNote, right: MemoryNote): number {
  return byCodePoint(left.slug, right.slug);
}

/** What a warn is remembered by: the message plus the two fields that identify the note. */
function warnKey(message: string, data?: Record<string, unknown>): string {
  return JSON.stringify([message, data?.path ?? null, data?.reason ?? null]);
}

/**
 * The logger a repository read is handed: a warn naming the same message, path
 * and reason twice reaches the real logger once.
 *
 * The repository is re-read on every call and its notes are untrusted, so the
 * same rejected file is met again and again; the caller wants to hear about it
 * once. Deduplicating here — rather than remembering rejected files — keeps the
 * read stateless and per host, and leaves every other level untouched.
 */
function oncePerHost(logger: MemoryLogger): MemoryLogger {
  const passed = new Set<string>();
  return {
    error: (stage, message, data) => logger.error(stage, message, data),
    info: (stage, message, data) => logger.info(stage, message, data),
    debug: (stage, message, data) => logger.debug(stage, message, data),
    warn: (stage, message, data) => {
      const key = warnKey(message, data);
      if (passed.has(key)) return;
      passed.add(key);
      logger.warn(stage, message, data);
    },
  };
}

/** Resolve the directories and build the store, the outbox and the provider over them. */
async function composeMemory(input: CreateMemoryHostInput): Promise<MemoryParts> {
  const dirs = await _memoryHostDeps.memoryDirs({ config: input.config, repoRoot: input.repoRoot });
  const store = _memoryHostDeps.createMemoryStore({
    projectDir: dirs.projectDir,
    userDir: dirs.userDir,
    logger: input.logger,
  });
  const outbox = _memoryHostDeps.createMemoryOutbox({ dir: store.paths.outboxDir });
  return { dirs, store, outbox, provider: _memoryHostDeps.createLocalMemoryProvider(store) };
}

/** Everything one host's reads are built from: where the mirror is, and the config that caps it. */
interface HostInput {
  readonly parts: MemoryParts;
  readonly config: MemoryConfig;
  readonly repoRoot: string;
  readonly logger: MemoryLogger;
}

/**
 * The project scope as it is measured, rather than as it is merged.
 *
 * The status reports the two counts separately — how much of its own the mirror
 * holds, and how much of the team's it does not shadow — and the index wants the
 * merge of them, so one read answers both.
 */
interface ProjectScope {
  /** The mirror's own project notes, in slug order. */
  readonly mirror: readonly MemoryNote[];
  /** The repository's notes whose slug the mirror does not hold, in slug order. */
  readonly unshadowed: readonly MemoryNote[];
  /** How many repository candidates a repo-note rule rejected. */
  readonly skipped: number;
}

/** One host's reads, closed over the composition and the repository they read from. */
interface HostReads {
  /** The mirror's own notes of one scope, in slug order. */
  mirrorNotes(scope: MemoryScope): Promise<readonly MemoryNote[]>;
  /** The project scope as two sets, with how many repo notes were skipped. */
  projectScope(): Promise<ProjectScope>;
  /** Every note the surface of one scope sees; only the project scope has repo notes. */
  notesOf(scope: MemoryScope): Promise<readonly MemoryNote[]>;
  /** The repository's committed project notes, as the last read of them found them. */
  repoNotes(): Promise<RepoNotes>;
}

/**
 * Build the reads over one composition.
 *
 * The repository is read through the once-per-host wrapper: every one of these
 * reads re-reads the repository, so a committed file that breaks a rule is met
 * again and again, and the wrapper is what keeps that to one warn per host.
 */
function createReads(input: HostInput): HostReads {
  const repoLogger = oncePerHost(input.logger);
  const repoNotes = () => _memoryHostDeps.readRepoNotes({ repoRoot: input.repoRoot, logger: repoLogger });
  const mirrorNotes = async (scope: MemoryScope) => (await input.parts.store.listNotes(scope)).sort(bySlug);
  /** The mirror's project notes, and the repository's that its slugs do not shadow. */
  async function projectScope(): Promise<ProjectScope> {
    const mirror = await mirrorNotes("project");
    const held = new Set(mirror.map((note) => note.slug));
    const repo = await repoNotes();
    return { mirror, unshadowed: repo.notes.filter((note) => !held.has(note.slug)), skipped: repo.skipped };
  }
  /** The mirror's project notes, then the repo notes whose slug none of them holds. */
  async function projectNotes(): Promise<readonly MemoryNote[]> {
    const scope = await projectScope();
    return [...scope.mirror, ...scope.unshadowed].sort(bySlug);
  }
  return {
    mirrorNotes,
    projectScope,
    notesOf: (scope) => (scope === "user" ? mirrorNotes("user") : projectNotes()),
    repoNotes,
  };
}

/** One keyword search over the scopes asked for; the project scope carries the repo notes. */
async function searchNotes(reads: HostReads, query: MemorySearchInput): Promise<readonly MemoryHit[]> {
  const searched =
    query.scope === undefined
      ? [...(await reads.notesOf("project")), ...(await reads.notesOf("user"))]
      : await reads.notesOf(query.scope);
  return searchMemoryNotes(searched, query.text, query.limit);
}

/**
 * The index a session starts with: feature 1's renderer over both scopes, the
 * project's decisions, the keys a queued forget still holds and the byte cap the
 * config sets. Every part is read now — the index is a snapshot, not a view.
 */
async function readIndex(reads: HostReads, input: HostInput): Promise<RenderedMemoryIndex> {
  const [projectNotes, userNotes, decisions, heldForgets] = await Promise.all([
    reads.notesOf("project"),
    reads.notesOf("user"),
    input.parts.store.readDecisions(),
    input.parts.outbox.heldKeys("forget"),
  ]);
  return renderMemoryIndex({ projectNotes, userNotes, decisions, heldForgets, maxBytes: input.config.indexBytes });
}

/** How many outbox entries are in one state: still to deliver, or refused by the provider. */
function countState(entries: readonly MemoryOutboxEntry[], state: "queued" | "rejected"): number {
  return entries.filter((entry) => entry.state === state).length;
}

/**
 * One sync: the composition handed to feature 1's scheduler.
 *
 * The scheduler owns the lock, the drain and the pull, and by its own contract
 * never throws — so a `locked`, `unreachable` or `failed` run is a result this host
 * passes on rather than an error it translates.
 */
function syncParts(input: HostInput): Promise<MemorySyncResult> {
  const { store, outbox, provider } = input.parts;
  return _memoryHostDeps.syncMemory({ store, outbox, provider, logger: input.logger });
}

/**
 * What the surfaces report about a host without calling one of its reads.
 *
 * The note counts are the mirror's own — a repo note is the repository's, and is
 * counted once by `repo` if the mirror's notes do not shadow it. `lastPullAt` and
 * `lastError` are whatever the last sync left in `sync.json`.
 */
async function readStatus(reads: HostReads, input: HostInput): Promise<MemoryStatus> {
  const [project, user, entries, sync] = await Promise.all([
    reads.projectScope(),
    reads.mirrorNotes("user"),
    input.parts.outbox.list(),
    input.parts.store.readSyncState(),
  ]);
  return {
    enabled: true,
    provider: input.parts.provider.id,
    writeMode: input.config.writeMode,
    projectDir: input.parts.dirs.projectDir,
    userDir: input.parts.dirs.userDir,
    lastPullAt: sync.lastPullAt,
    lastError: sync.lastError,
    queued: countState(entries, "queued"),
    rejected: countState(entries, "rejected"),
    notes: { project: project.mirror.length, user: user.length, repo: project.unshadowed.length },
    repoSkipped: project.skipped,
  };
}

/**
 * Create the memory host for a session, or `null` when memory is disabled.
 *
 * The disabled check comes before the first dependency call: a project with
 * memory off must not have its repository resolved, hashed or read at all.
 *
 * Sync is delegated whole: `syncMemory` owns the lock, the drain and the pull, and
 * by its own contract never throws, so a `locked` or `failed` run is a result this
 * host reports rather than an error it translates.
 *
 * The writes are built from the same composition and the same reads: they take the
 * repository's notes through the reads' own (warn-deduplicated) view, and feature
 * 1's operations through `_memoryHostDeps`, so an operation stubbed after the host
 * was opened is the one the next write calls.
 *
 * @param input.config - The loaded nax config (`memory` is read through `memoryConfigOf`)
 * @param input.repoRoot - Absolute repository root; the `.nax` anchor and the mirror identity
 * @param input.source - The label a note this host writes records as its origin
 * @param input.logger - Where the host and every repository read log
 * @throws {NaxError} `MEMORY_REPO_ROOT_UNRESOLVED` when the repository root cannot be resolved
 */
export async function createMemoryHost(input: CreateMemoryHostInput): Promise<MemoryHost | null> {
  const config = memoryConfigOf(input.config);
  if (!config.enabled) return null;
  const parts = await composeMemory(input);
  const hostInput: HostInput = { parts, config, repoRoot: input.repoRoot, logger: input.logger };
  const reads = createReads(hostInput);
  const writes = createHostWrites({
    store: parts.store,
    outbox: parts.outbox,
    provider: parts.provider,
    logger: input.logger,
    source: input.source,
    writeMode: config.writeMode,
    repoNotes: async () => (await reads.repoNotes()).notes,
    operations: _memoryHostDeps,
  });
  return {
    dirs: parts.dirs,
    providerId: parts.provider.id,
    writeMode: config.writeMode,
    notes: reads.notesOf,
    getNote: async (scope, slug) => (await reads.notesOf(scope)).find((note) => note.slug === slug) ?? null,
    search: (query) => searchNotes(reads, query),
    renderIndex: () => readIndex(reads, hostInput),
    sync: () => syncParts(hostInput),
    status: () => readStatus(reads, hostInput),
    save: writes.save,
    forget: writes.forget,
    approve: writes.approve,
  };
}
