/**
 * AcpAgentAdapter.closePhysicalSession implementation — split out of adapter.ts
 * to stay under the file-size ratchet.
 */

import { SESSION_CLOSE_PERMISSION_MODE } from "@/config";
import { getSafeLogger } from "@/logger";
import { _acpAdapterDeps } from "./adapter-lifecycle";

export async function closePhysicalSession(
  agentName: string,
  handle: string,
  workdir: string,
  options?: { force?: boolean; signal?: AbortSignal },
): Promise<void> {
  const cmdStr = `acpx ${agentName}`;
  const client = _acpAdapterDeps.createClient(cmdStr, workdir, undefined, undefined);
  try {
    await client.start();
    try {
      if (client.closeSession) {
        await client.closeSession(handle, agentName, options?.signal);
        // AC-83: hard-terminate (acpx stop) when force=true, e.g. for errored sessions
        if (options?.force) {
          await client.forceStop?.(agentName, options?.signal).catch(() => {});
        }
      } else if (client.loadSession) {
        const session = await client.loadSession(handle, agentName, SESSION_CLOSE_PERMISSION_MODE);
        if (session) await session.close({ forceTerminate: options?.force, signal: options?.signal }).catch(() => {});
      }
    } catch (err) {
      getSafeLogger()?.warn("acp-adapter", `[close] Failed to close session ${handle}`, { error: String(err) });
    }
  } finally {
    await client.close().catch(() => {});
  }
}
