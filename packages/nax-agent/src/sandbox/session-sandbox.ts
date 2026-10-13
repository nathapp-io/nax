/** nax#2500: a launcher's sandbox as plain data for a backend that runs its own shell. */
import type { CommandLauncher, SessionSandbox } from "./types.ts";

export async function sessionSandboxFrom(
  launcher: CommandLauncher | undefined,
  root: string,
): Promise<SessionSandbox | undefined> {
  if (launcher === undefined || launcher.state.kind === "disabled") return undefined;
  if (launcher.state.kind === "unavailable") return { kind: "unavailable", reason: launcher.state.reason };
  if (launcher.policyAt === undefined) return { kind: "unavailable", reason: "the launcher exposes no policy" };
  return { kind: "policy", policy: await launcher.policyAt(root) };
}
