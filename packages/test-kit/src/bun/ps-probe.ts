/**
 * Can `ps` report a process group on this host?
 *
 * `ps` is a setuid program, and both a confined OS sandbox and a sandboxed agent
 * session withhold it (the macOS Seatbelt profile refuses it outright; the
 * session's own sandbox does the same). A spawn case that reads its own process
 * group with `ps` is therefore environment-dependent, not a runtime behaviour:
 * its expectation cannot be met where `ps` answers nothing. Decided by asking
 * `ps` itself, never by a platform guess — on a host where it works the case
 * runs, and where it does not the case skips with that reason.
 */
import { spawnSync } from "node:child_process";

/** True when `ps -o pgid= -p <self>` prints a positive process-group id. */
export function psCanReportProcessGroup(): boolean {
  try {
    const r = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
    return r.status === 0 && Number((r.stdout ?? "").trim()) > 0;
  } catch {
    return false;
  }
}
