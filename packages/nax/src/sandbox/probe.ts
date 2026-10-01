/**
 * Is the sandbox actually working here? Decided by RUNNING one wrapped
 * command, never by a dependency check: in stock Docker bwrap is installed
 * and every command fails (spec F4), and a sandbox that runs but does not
 * enforce must count as absent, not present.
 *
 * The denied marker sits under the probe's own write root and is listed in
 * denyWrite: srt's deny-within-allow wins on both platforms (spec 5.4). A
 * marker merely "outside the roots" would be inside a tmp write root in
 * production and falsely read as a leak.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArgv } from "../utils/argv-exec";
import { realOrRaw } from "../utils/realpath";
import type { ProbeResult, SandboxBackend } from "./types";

const PROBE_TIMEOUT_MS = 30_000;

export const _probeDeps = { tmpdir, runArgv };

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export async function probeSandbox(backend: SandboxBackend): Promise<ProbeResult> {
  if (!(await backend.isSupportedPlatform())) {
    return { available: false, reason: `platform ${process.platform} is not supported by the ${backend.name} sandbox` };
  }
  const dir = realOrRaw(mkdtempSync(join(_probeDeps.tmpdir(), "nax-sandbox-probe-")));
  mkdirSync(join(dir, "allowed"));
  mkdirSync(join(dir, "denied"));
  const allowed = join(dir, "allowed", "marker");
  const denied = join(dir, "denied", "marker");
  try {
    let argv: readonly string[];
    try {
      argv = await backend.wrap({
        command: `echo ok > ${allowed}; echo leak > ${denied}; exit 0`,
        shell: "/bin/sh",
        policy: { writeRoots: [dir], denyWrite: [denied], denyRead: [], network: {} },
        cwd: dir,
        commandId: "nax-sandbox-probe",
      });
    } catch (err) {
      return { available: false, reason: `sandbox wrap failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    let result: Awaited<ReturnType<typeof runArgv>>;
    try {
      result = await _probeDeps.runArgv({ argv, cwd: dir, timeoutMs: PROBE_TIMEOUT_MS });
    } finally {
      // Exactly once per successful wrap, even when the spawn itself throws.
      backend.commandFinished();
    }
    if (!existsSync(allowed)) {
      return {
        available: false,
        reason: `sandbox could not run a command: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`,
      };
    }
    if (existsSync(denied))
      return { available: false, reason: "sandbox ran a command but did not enforce a write deny" };
    return { available: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
