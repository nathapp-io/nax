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
 */
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseModelSpec } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";

export const RECENT_MODELS_FILE = "chat-recent-models.json";
/** How many models the list keeps; the newest is the one that survives the longest. */
export const MAX_RECENT_MODELS = 5;
const RECENT_MODELS_VERSION = 1;

export interface RecentModelStore {
  load(): Promise<readonly string[]>;
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

export function createRecentModelStore(input: {
  readonly path: string;
  readonly logger?: Pick<Logger, "warn">;
}): RecentModelStore {
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
      const temp = `${input.path}.${_recentModelStoreDeps.randomUUID()}.tmp`;
      try {
        _recentModelStoreDeps.mkdir(dirname(input.path), { recursive: true });
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
    },
  };
}
