/** Attributes carried by every heartbeat gauge (US-008). */
export interface HeartbeatAttributes {
  runId: string;
  feature: string;
  project: string;
  storyId: string;
  phase: string;
  tier: string;
  testStrategy: string;
}

/** Point-in-time state a heartbeat tick exports as `nax.run.*` gauges. */
export interface HeartbeatSnapshot {
  attributes: HeartbeatAttributes;
  /** Elapsed ms since the most recently completed phase event. */
  phaseElapsedMs: number;
  /** Run's accumulated cost in USD. */
  costUsd: number;
}

export interface HeartbeatOptions {
  /** Cadence in ms. `0` must disable the heartbeat entirely. */
  intervalMs: number;
  /** Called on each tick to build the snapshot to export. */
  getSnapshot: () => HeartbeatSnapshot;
  /** Invoked once per elapsed interval with the current snapshot. */
  onTick: (snapshot: HeartbeatSnapshot) => void | Promise<void>;
}

export interface Heartbeat {
  /** Stops future ticks. Idempotent. */
  stop(): void;
}

/** Starts a repeating heartbeat timer. Stub — scheduling not yet implemented. */
export function startHeartbeat(_opts: HeartbeatOptions): Heartbeat {
  return { stop() {} };
}
