/** A separate process attempting stale-lock takeover at the parent's mutation barrier. */
import { readFileSync } from "node:fs";
import type { AgentLogger } from "#src/infra/index";
import { acquireSessionLock } from "#src/session-store/session-lock";
import { SessionLockGuardBusy, withSessionLockGuard } from "#src/session-store/session-lock-guard";

const logger: AgentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const path = process.argv[2];
if (path === undefined) throw new Error("missing lock path");
if (process.argv[3] === "crash-guard") withSessionLockGuard(path, () => process.exit(0));
try {
  acquireSessionLock(
    path,
    {
      dir: ".",
      pid: process.pid,
      now: () => new Date("2030-01-01T00:00:00Z"),
      logger,
    },
    () => true,
  );
  console.log(JSON.stringify({ acquired: true, body: JSON.parse(readFileSync(path, "utf8")) }));
} catch (error) {
  // Only real guard contention counts as a blocked takeover, not a fixture failure.
  if (!(error instanceof SessionLockGuardBusy)) throw error;
  console.log(JSON.stringify({ acquired: false }));
}
