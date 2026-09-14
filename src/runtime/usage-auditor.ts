// Per-round-trip usage sidecar.
//
// One JSONL line per `agent.usage_update`, written to a file of its own rather
// than the run log. Volume sanity: ~161 events per call at roughly 200 bytes is
// ~32 KB per call — negligible as its own file, but real noise in the run log,
// which is exactly why this is a sidecar. The run log keeps the activity
// counters in `middleware/agent-stream-logging.ts`; the payload lands here.
//
// Persistence uses `appendFileSync` through `_usageAuditorDeps.appendLine`. See
// the header comment in `src/runtime/prompt-auditor.ts` for why the sync variant
// (not async `appendFile`) is deliberate; this file copies that structure.
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import { type CanonicalSessionRole, KNOWN_SESSION_ROLES } from "./session-role";

export interface UsageAuditEntry {
  readonly ts: number;
  readonly runId: string;
  /**
   * The exact join key for this dispatch — the transcript's `owner` and the
   * cost ledger's `scopeId`. Copy-free from the source event; absent means
   * "unknown" and must never be coerced to `""` or the `streamCallId`.
   */
  readonly scopeId?: string;
  /**
   * The emitting event's `callId` — a stream-local UUID, NOT a durable join
   * key. Named `streamCallId` on the row so nobody mistakes it for the ledger's
   * `callId`; the join key is `scopeId`.
   */
  readonly streamCallId: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: string;
  readonly agentName: string;
  readonly roundTrip?: number;
  readonly cadence?: "round-trip" | "agent";
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly costUsd?: number;
}

export interface IUsageAuditor {
  record(entry: UsageAuditEntry): void;
  flush(): Promise<void>;
}

export function createNoOpUsageAuditor(): IUsageAuditor {
  return {
    record() {},
    async flush() {},
  };
}

/** Injectable deps — swap in tests to avoid real disk I/O. */
export const _usageAuditorDeps = {
  // Sync append: see prompt-auditor.ts header for the silent-drop rationale.
  // Returns Promise<void> so the call site stays symmetric with the rest of the
  // write chain, which the `_queue` serializes.
  appendLine: async (path: string, data: string): Promise<void> => {
    appendFileSync(path, data, "utf8");
  },
};

const ROLES_BY_DESCENDING_LENGTH: readonly CanonicalSessionRole[] = [...KNOWN_SESSION_ROLES].sort(
  (a, b) => b.length - a.length,
);

/**
 * Derive the canonical session role from a session name by the longest
 * trailing, `-`-bounded match against `KNOWN_SESSION_ROLES`. Multi-segment roles
 * (`repo-scoped-test-fix`, `reviewer-semantic`) require the longest match — a
 * last-segment-only split would mislabel them. No match, including `debate-*`,
 * returns undefined so the row omits `sessionRole` rather than emitting a
 * free-form string (`session-role.ts` bans those outright).
 */
export function deriveSessionRole(sessionName: string): CanonicalSessionRole | undefined {
  for (const role of ROLES_BY_DESCENDING_LENGTH) {
    if (sessionName === role || sessionName.endsWith(`-${role}`)) return role;
  }
  return undefined;
}

export class UsageAuditor implements IUsageAuditor {
  private _queue: Promise<void> = Promise.resolve();
  private _dirCreated = false;
  private readonly _dir: string;
  private readonly _jsonlPath: string;

  constructor(runId: string, dir: string) {
    this._dir = dir;
    this._jsonlPath = join(dir, `${runId}.jsonl`);
  }

  record(entry: UsageAuditEntry): void {
    this._queue = this._queue
      .then(() => this._writeEntry(entry))
      .catch((err) => {
        // A per-entry failure (disk full, permission denied, transient FS stall)
        // must not break the chain or the run. Log enough context to correlate
        // the dropped row with the rest of the run's artifacts — see the
        // prompt-auditor header for the silent-drop incident this guard exists
        // for.
        const sysErr = err as NodeJS.ErrnoException;
        getSafeLogger()?.warn("audit", "usage-audit write failed", {
          path: this._jsonlPath,
          error: errorMessage(err),
          code: sysErr?.code,
          errno: sysErr?.errno,
          syscall: sysErr?.syscall,
          ts: entry.ts,
          storyId: entry.storyId,
          sessionName: entry.sessionName,
          agentName: entry.agentName,
          stage: entry.stage,
          streamCallId: entry.streamCallId,
        });
      });
  }

  private async _writeEntry(entry: UsageAuditEntry): Promise<void> {
    if (!this._dirCreated) {
      await mkdir(this._dir, { recursive: true });
      this._dirCreated = true;
    }
    // `sessionRole` is derived here, never accepted from the caller, so a row can
    // never carry a free-form role. An undefined role stringifies out entirely.
    const row = { ...entry, sessionRole: deriveSessionRole(entry.sessionName) };
    await _usageAuditorDeps.appendLine(this._jsonlPath, `${JSON.stringify(row)}\n`);
  }

  async flush(): Promise<void> {
    await this._queue;
  }
}
