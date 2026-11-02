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
 * The index, sync and the write paths arrive in US-006 and US-007; until then
 * each answers with a `MEMORY_NOT_IMPLEMENTED` `NaxError` rather than a silent
 * empty result, so a caller wired too early fails loudly.
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
  type MemoryProvider,
  type MemorySaveResult,
  type MemoryScope,
  type MemoryStore,
  type MemorySyncResult,
  type RenderedMemoryIndex,
  saveMemoryNote,
  searchMemoryNotes,
  syncMemory,
} from "@nathapp/nax-agent";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { memoryConfigOf, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { type MemoryDirs, type MemoryLogger, memoryDirs } from "./paths";
import { readRepoNotes } from "./repo-notes";

/** Stage every host log line and error carries. */
const LOG_STAGE = "memory";

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

/** The refusal a surface wired ahead of its story gets: never a silent empty answer. */
function notImplemented(operation: string): NaxError {
  return new NaxError(`[memory] ${operation} is not implemented yet`, "MEMORY_NOT_IMPLEMENTED", {
    stage: LOG_STAGE,
    operation,
  });
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

/**
 * Create the memory host for a session, or `null` when memory is disabled.
 *
 * The disabled check comes before the first dependency call: a project with
 * memory off must not have its repository resolved, hashed or read at all.
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
  const repoLogger = oncePerHost(input.logger);
  /** The repository's committed notes, read afresh and warned about once per host. */
  const repoNotes = () => _memoryHostDeps.readRepoNotes({ repoRoot: input.repoRoot, logger: repoLogger });
  /** One scope's own notes, in slug order. */
  const mirrorNotes = async (scope: MemoryScope) => (await parts.store.listNotes(scope)).sort(bySlug);
  /** The mirror's project notes, then the repo notes whose slug none of them holds. */
  async function projectNotes(): Promise<readonly MemoryNote[]> {
    const mirror = await mirrorNotes("project");
    const held = new Set(mirror.map((note) => note.slug));
    const additions = (await repoNotes()).notes.filter((note) => !held.has(note.slug));
    return [...mirror, ...additions].sort(bySlug);
  }
  /** Every note the surface of one scope sees; only the project scope has repo notes. */
  const notesOf = (scope: MemoryScope) => (scope === "user" ? mirrorNotes("user") : projectNotes());
  const host: MemoryHost = {
    dirs: parts.dirs,
    providerId: parts.provider.id,
    writeMode: config.writeMode,
    notes: notesOf,
    getNote: async (scope, slug) => (await notesOf(scope)).find((note) => note.slug === slug) ?? null,
    search: async (query) => {
      const searched =
        query.scope === undefined
          ? [...(await notesOf("project")), ...(await notesOf("user"))]
          : await notesOf(query.scope);
      return searchMemoryNotes(searched, query.text, query.limit);
    },
    renderIndex: () => Promise.reject(notImplemented("renderIndex")),
    sync: () => Promise.reject(notImplemented("sync")),
    status: () => Promise.reject(notImplemented("status")),
    save: () => Promise.reject(notImplemented("save")),
    forget: () => Promise.reject(notImplemented("forget")),
    approve: () => Promise.reject(notImplemented("approve")),
  };
  return host;
}
