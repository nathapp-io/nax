/**
 * The per-story shadow (spec 4.1, 4.3, 4.4, 4.6).
 *
 * observe() scores the rules synchronously and starts classification; it is
 * never awaited by the caller. settle() attaches the ledger outcome. A row is
 * written once both halves exist. Every method is total: what stops on a
 * failure is the row's model half (or the row), never the call.
 */
import { callIdentifiers } from "./identifiers";
import { QUESTION_SET_VERSION } from "./questions";
import { scoreRules } from "./rule-scorer";
import type { Classify } from "./systemone-client";
import type {
  CommandSafetyRow,
  CommandShadow,
  ExecRun,
  FinalOutcome,
  LedgerOutcome,
  ModelResult,
  Observation,
  RuleResult,
} from "./types";

export interface CommandShadowOptions {
  readonly classify: Classify;
  readonly write: (row: CommandSafetyRow) => Promise<void>;
  readonly runId: string;
  /** Bounds drain(); the same value as the client timeout. */
  readonly timeoutMs: number;
  readonly onWriteError?: (err: unknown) => void;
}

export const _commandShadowDeps = {
  /**
   * setTimeout, not Bun.sleep: the drain bound must be CANCELLED when the
   * pending rows finish first, or every story would wait out the full timeout
   * (the documented exception in forbidden-patterns-source).
   */
  timer: (ms: number): { readonly done: Promise<void>; cancel(): void } => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return { done, cancel: () => clearTimeout(handle) };
  },
  now: (): string => new Date().toISOString(),
};

/** Exact command plus the question-set version. No normalization of any kind (D17). */
export function shadowCacheKey(command: string): string {
  return `v${QUESTION_SET_VERSION}\u0000${command}`;
}

interface Entry {
  readonly obs: Observation;
  readonly rules: RuleResult;
  model?: { readonly result: ModelResult; readonly cached: boolean };
  outcome?: { readonly ledger: LedgerOutcome | "unsettled"; readonly decidedBy?: string };
  /** Exec only: what actually ran, set at settle. */
  run?: ExecRun;
  written: boolean;
}

const THREW: ModelResult = { status: "unavailable", error: "threw" };
const DRAINED: ModelResult = { status: "unavailable", error: "drained" };

export function createCommandShadow(opts: CommandShadowOptions): CommandShadow {
  const entries = new Map<string, Entry>();
  const cache = new Map<string, Promise<ModelResult>>();
  const inFlight = new Set<Promise<void>>();
  const writes = new Set<Promise<void>>();

  const track = (set: Set<Promise<void>>, p: Promise<void>) => {
    set.add(p);
    // .catch: finally() re-rejects, and nothing else observes this promise.
    void p.finally(() => set.delete(p)).catch(() => undefined);
  };

  function classifyCached(command: string): { promise: Promise<ModelResult>; cached: boolean } {
    const key = shadowCacheKey(command);
    const hit = cache.get(key);
    if (hit !== undefined) return { promise: hit, cached: true };
    // Called synchronously so classification starts at once (and so a test can
    // answer it right after observe); the try turns a synchronous throw into
    // the same `threw` result as a rejection.
    let started: Promise<ModelResult>;
    try {
      started = Promise.resolve(opts.classify(command));
    } catch {
      started = Promise.resolve(THREW);
    }
    const promise = started.catch((): ModelResult => THREW);
    cache.set(key, promise);
    void promise.then((r) => {
      if (r.status === "unavailable" && cache.get(key) === promise) cache.delete(key);
    });
    return { promise, cached: false };
  }

  function flush(key: string, entry: Entry): void {
    if (entry.written || entry.model === undefined || entry.outcome === undefined) return;
    entry.written = true;
    entries.delete(key);
    track(
      writes,
      opts.write(toRow(entry, entry.model, entry.outcome)).catch((err: unknown) => opts.onWriteError?.(err)),
    );
  }

  function toRow(
    entry: Entry,
    model: NonNullable<Entry["model"]>,
    outcome: NonNullable<Entry["outcome"]>,
  ): CommandSafetyRow {
    const { obs } = entry;
    const r = model.result;
    const cwd = entry.run?.cwd ?? obs.cwd;
    return {
      at: _commandShadowDeps.now(),
      runId: opts.runId,
      ...(obs.storyId !== undefined ? { storyId: obs.storyId } : {}),
      stage: obs.stage,
      identity: obs.identity,
      command: obs.command,
      ...(obs.argv !== undefined ? { argv: obs.argv } : {}),
      ...(entry.run !== undefined ? { executed: entry.run.executed } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      mechanical: obs.mechanical,
      outcome,
      rules: entry.rules,
      ...callIdentifiers(obs),
      model: {
        status: model.cached && r.status === "answered" ? "cached" : r.status,
        questionSetVersion: QUESTION_SET_VERSION,
        ...(r.status === "answered" ? { answers: r.answers } : {}),
        ...(r.status === "answered" && r.model !== undefined ? { model: r.model } : {}),
        ...((r.status === "answered" || r.status === "blocked") && r.decisionId !== undefined
          ? { decisionId: r.decisionId }
          : {}),
        ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}),
        ...(r.status === "unavailable" ? { error: r.error } : {}),
      },
    };
  }

  return {
    observe(key, obs) {
      try {
        if (entries.has(key)) return;
        const entry: Entry = { obs, rules: scoreRules(obs.command), written: false };
        entries.set(key, entry);
        const { promise, cached } = classifyCached(obs.command);
        track(
          inFlight,
          promise.then((result) => {
            if (entry.written) return;
            entry.model = { result, cached };
            flush(key, entry);
          }),
        );
      } catch {
        // Total by contract (spec 4.3): a shadow failure must never reach callTool.
      }
    },

    settle(key, outcome: FinalOutcome, run?: ExecRun) {
      try {
        const entry = entries.get(key);
        if (entry === undefined || entry.outcome !== undefined) return;
        entry.outcome = outcome;
        if (run !== undefined) entry.run = run;
        flush(key, entry);
      } catch {
        // Total by contract (spec 4.3).
      }
    },

    async drain() {
      try {
        const timer = _commandShadowDeps.timer(opts.timeoutMs);
        try {
          await Promise.race([Promise.allSettled([...inFlight]), timer.done]);
        } finally {
          timer.cancel();
        }
        for (const [key, entry] of [...entries]) {
          entry.model ??= { result: DRAINED, cached: false };
          entry.outcome ??= { ledger: "unsettled" };
          flush(key, entry);
        }
        await Promise.allSettled([...writes]);
      } catch {
        // drain() is awaited in the execution stage's finally; it must not throw.
      }
    },
  };
}
