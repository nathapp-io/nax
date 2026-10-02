/**
 * Injectable spawn/teardown/startup dependencies shared by SpawnAcpClient
 * (spawn-client.ts) and SpawnAcpSession (spawn-client-session.ts). Split out
 * to a standalone module so both files can import it without an import cycle
 * between them.
 */

import { typedSpawn } from "@/utils/bun-deps";

// Grace period for stream drain after acpx exits — handles Bun bug where
// piped streams may not close after SIGTERM (e.g. cancelActivePrompt).
const ACPX_STREAM_DRAIN_TIMEOUT_MS = 5_000;

// ORPHAN-1: SIGTERM->SIGKILL escalation grace period for killProcessTree() (see
// spawn-client-process.ts). Shorter than executor.ts's since close()/
// cancelActivePrompt() are already tearing the session down.
const KILL_TREE_GRACE_MS = 250;

// PERF-1: hard deadline on trackedSpawn's proc.exited await (see
// spawn-client-process.ts) — bounds the normal-exit teardown path the same way
// the crash-signal path's outer 10s hard deadline bounds crash-signals.ts.
// Issue #1583: this bound is for TEARDOWN ops only (sessions close/stop/cancel
// via SpawnAcpSession.trackedSpawn) — do not reuse for startup ops, see
// TRACKED_SPAWN_STARTUP_DEADLINE_MS below. Config default lives at
// config.agent.acp.trackedSpawnDeadlineMs (src/config/schemas-infra.ts).
const TRACKED_SPAWN_DEADLINE_MS = 10_000;

// Issue #1583: `sessions ensure` (createSession/loadSession/applyReasoningEffort
// via SpawnAcpClient.trackedSpawn) is a STARTUP op, not teardown — it measured a
// real-world median of 8.15s. Reusing the 10s teardown deadline left ~1.85s of
// margin, and under concurrency nax was SIGTERMing healthy-but-slow acpx
// processes and silently falling back to context-less sessions. Config default
// lives at config.agent.acp.trackedSpawnStartupDeadlineMs.
const TRACKED_SPAWN_STARTUP_DEADLINE_MS = 30_000;

export const _spawnClientDeps = {
  spawn: typedSpawn,
  /** Stream drain timeout after proc.exited — injectable so tests can use a short value. */
  streamDrainTimeoutMs: ACPX_STREAM_DRAIN_TIMEOUT_MS,
  /** SIGTERM->SIGKILL escalation grace period — injectable so tests can use a short value. */
  killTreeGraceMs: KILL_TREE_GRACE_MS,
  /** trackedSpawn hard deadline for teardown ops — injectable so tests can use a short value. */
  trackedSpawnDeadlineMs: TRACKED_SPAWN_DEADLINE_MS,
  /** trackedSpawn hard deadline for startup ops (#1583) — injectable so tests can use a short value. */
  trackedSpawnStartupDeadlineMs: TRACKED_SPAWN_STARTUP_DEADLINE_MS,
};
