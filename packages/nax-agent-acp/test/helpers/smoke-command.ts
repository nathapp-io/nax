/** Runs one packed-smoke command; any other exit status, signal or deadline throws with its output. */
import { spawnSync } from "node:child_process";

export function runSmokeCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
  acceptedExitCodes: readonly number[] = [0],
): string {
  const proc = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  if (proc.error || proc.status === null || !acceptedExitCodes.includes(proc.status)) {
    throw new Error(
      `${cmd} ${args.join(" ")} (cwd ${cwd}) failed with status ${proc.status}, signal ${proc.signal}, deadline ${timeoutMs}ms: ${proc.error?.message ?? "command exited unsuccessfully"}\n${proc.stdout ?? ""}${proc.stderr ?? ""}`,
    );
  }
  return proc.stdout + proc.stderr;
}
