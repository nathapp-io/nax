/**
 * The models this chat used recently, newest first, with the effort each was last used at.
 *
 * `/model` used to list the catalogue and nothing else, so going back to the model and effort
 * used an hour ago meant finding the row again and cycling the effort again — and two providers
 * offering the same model name (`openai/gpt-6.1-sol` and `openai-codex/gpt-6.1-sol`) gave two
 * rows that looked alike. The list is therefore unique by *base* — `provider/model`, the model
 * without its `[effort]` suffix — so each provider's row is its own entry, and re-recording a
 * base replaces its effort and moves it to the front.
 *
 * The store mirrors `createAcpOfferStore`: versioned JSON beside the sessions directory, an
 * atomic write through a temp file, and a load that answers an empty list rather than throwing.
 * A caller that cannot read the list still has a usable `/model`.
 *
 * Unlike the offer store, this file is shared by every chat process in one sessions directory
 * (two terminals, two worktrees, an editor's integrated terminal). A save is therefore a
 * recording, not a replacement: it takes the shared single-file lock, re-reads the list on
 * disk, applies the caller's newest entry to *that*, and writes the result — so the last chat
 * to save cannot erase the four models another chat recorded since either of them started.
 */
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseModelSpec } from "@nathapp/nax-agent";
import { withFileLock } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";

export const RECENT_MODELS_FILE = "chat-recent-models.json";
/** How many models the list keeps; the newest is the one that survives the longest. */
export const MAX_RECENT_MODELS = 5;
const RECENT_MODELS_VERSION = 1;
const LOCK_OPTIONS = { lockName: "recent-models", errorPrefix: "[chat]" } as const;

export interface RecentModelStore {
  load(): Promise<readonly string[]>;
  /**
   * Persist `models` (newest first). The caller's newest entry is applied to the list already
   * on disk and its older entries are carried over, so two chats sharing the file merge rather
   * than overwrite.
   */
  save(models: readonly string[]): Promise<void>;
}

/** The store's injected seams: the file operations and the temp file's name. */
export const _recentModelStoreDeps = {
  read: (path: string): Promise<unknown> => Bun.file(path).json(),
  write: (path: string, content: string): Promise<number> => Bun.write(path, content),
  rename: renameSync,
  mkdir: mkdirSync,
  unlink: unlinkSync,
  randomUUID: (): string => crypto.randomUUID(),
};

export function recentModelsPath(sessionsDir: string): string {
  return join(sessionsDir, RECENT_MODELS_FILE);
}

/** The provider-qualified model an entry names, without the effort suffix it was used at. */
function baseOf(model: string): string {
  return parseModelSpec(model).model;
}

/**
 * The list after `model` was used: it goes to the front with the effort it was used at, the
 * entry whose base it replaces is dropped, and the oldest entry is dropped past
 * `MAX_RECENT_MODELS`.
 */
export function recordRecentModel(recents: readonly string[], model: string): readonly string[] {
  const base = baseOf(model);
  const kept = recents.filter((entry) => baseOf(entry) !== base);
  return [model, ...kept].slice(0, MAX_RECENT_MODELS);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A stored list is re-read by the same rules it is written with: distinct bases, newest first. */
function normalize(models: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const distinct = models.filter((model) => {
    const base = baseOf(model);
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
  return distinct.slice(0, MAX_RECENT_MODELS);
}

function decode(value: unknown): readonly string[] {
  if (!record(value) || value.version !== RECENT_MODELS_VERSION) {
    throw new NaxError("[chat] Unsupported recent models version", "CHAT_RECENT_MODELS_INVALID", { stage: "chat" });
  }
  return normalize(strings(value.models));
}

/**
 * What a save leaves on disk: the caller's newest entry applied to the list that is there now
 * (that entry is the fact this save contributes, and the disk is the truth about everything
 * older), followed by any older entry the caller knew about and the disk does not. Nothing the
 * disk holds is dropped by this merge — only the cap drops entries, oldest first.
 */
function mergeRecentModels(stored: readonly string[], models: readonly string[]): readonly string[] {
  const [newest, ...older] = models;
  if (newest === undefined) return stored;
  const merged = recordRecentModel(stored, newest);
  const absent = older.filter((model) => !merged.some((entry) => baseOf(entry) === baseOf(model)));
  return [...merged, ...absent].slice(0, MAX_RECENT_MODELS);
}

export function createRecentModelStore(input: {
  readonly path: string;
  readonly logger?: Pick<Logger, "warn">;
}): RecentModelStore {
  /** The list on disk right now; `[]` when it cannot be read, because a recording must still land. */
  async function stored(): Promise<readonly string[]> {
    try {
      return decode(await _recentModelStoreDeps.read(input.path));
    } catch {
      // A missing, unreadable or wrong-version file has nothing to merge with. The load path is
      // what reports it; failing this write would cost the model that was just used.
      return [];
    }
  }

  /** Publish `models` through a temp file and a rename, so a reader never sees half a list. */
  async function write(models: readonly string[]): Promise<void> {
    const temp = `${input.path}.${_recentModelStoreDeps.randomUUID()}.tmp`;
    try {
      await _recentModelStoreDeps.write(temp, JSON.stringify({ version: RECENT_MODELS_VERSION, models }, null, 2));
      _recentModelStoreDeps.rename(temp, input.path);
    } catch (error) {
      try {
        _recentModelStoreDeps.unlink(temp);
      } catch {
        // Cleanup is best-effort: the write or rename error is the one the caller reports.
      }
      throw error;
    }
  }

  return {
    async load() {
      try {
        return decode(await _recentModelStoreDeps.read(input.path));
      } catch (error) {
        if (!(record(error) && error.code === "ENOENT")) {
          input.logger?.warn("chat", `Failed to load recent models from ${input.path}`, { error });
        }
        return [];
      }
    },
    async save(models) {
      // The parent is created before the lock is taken: the lock file lives beside the store.
      _recentModelStoreDeps.mkdir(dirname(input.path), { recursive: true });
      await withFileLock(
        `${input.path}.lock`,
        async () => write(mergeRecentModels(await stored(), models)),
        LOCK_OPTIONS,
      );
    },
  };
}
