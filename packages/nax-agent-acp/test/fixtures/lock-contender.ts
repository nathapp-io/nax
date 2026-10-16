/** A separate process attempting stale-lock takeover at the parent's mutation barrier. */
import { readFileSync } from "node:fs";
import { acquireSessionLock } from "#src/server/session-lock";
import { withSessionLockGuard } from "#src/server/session-lock-guard";
import { recordingLogger } from "#test/helpers/recording-logger";

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
      logger: recordingLogger().logger,
    },
    () => true,
  );
  console.log(JSON.stringify({ acquired: true, body: JSON.parse(readFileSync(path, "utf8")) }));
} catch {
  console.log(JSON.stringify({ acquired: false }));
}
