/**
 * S4b-3 D2-b: which model ids each installed ACP agent offers, compared with the
 * ids nax is configured to send. Opens a session with a model id no agent offers,
 * so the open stops at the model step (after initialize + session/new) and the
 * refusal lists the offered ids. No prompt is sent; nothing is billed.
 *
 * Usage (from packages/nax-agent-acp):
 *   bun test/node/fixtures/model-probe.mjs codex=gpt-6-luna,gpt-6-sol opencode=minimax/MiniMax-M3
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { acpBackend, launchCandidateKind } from "@nathapp/nax-agent-acp/client";

const AGENTS = new Set(["claude", "codex", "gemini", "opencode", "pi"]);
const PROBE_MODEL = "nax-model-probe-unknown";

async function offeredIds(agent) {
  const workdir = mkdtempSync(join(tmpdir(), `acp-model-probe-${agent}-`));
  try {
    const session = await createAgentSession({
      backend: acpBackend({ agent, allowUnsandboxed: true, initializeTimeoutMs: 120_000, model: PROBE_MODEL }),
      profile: "full",
      workdir,
      transcriptStore: createMemoryTranscriptStore(),
    });
    await session.close();
    return { error: "the probe model was accepted; the agent has no exact-match model option" };
  } catch (error) {
    if (error?.code === "AGENT_SESSION_CAPABILITY_UNSUPPORTED" && Array.isArray(error?.context?.offered)) {
      return { offered: error.context.offered };
    }
    return { error: `${error?.code ?? "error"} ${error?.message ?? String(error)}` };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

for (const arg of process.argv.slice(2)) {
  const [agent, list = ""] = arg.split("=");
  const wanted = list.split(",").filter((id) => id !== "");
  if (!AGENTS.has(agent)) {
    console.log(`${agent}: unknown agent`);
    continue;
  }
  // The backend's own resolution, npx fallback included (an npx-only launcher is the likely case for codex/pi).
  const kind = launchCandidateKind(agent);
  if (kind === undefined) {
    console.log(`${agent}: no launch candidate (not installed, and no npx)`);
    continue;
  }
  if (kind === "npx") console.log(`${agent}: launching through npx (first run downloads the launcher)`);
  const probe = await offeredIds(agent);
  if (probe.error !== undefined) {
    console.log(`${agent}: ${probe.error}`);
    continue;
  }
  console.log(`${agent}: offers ${JSON.stringify(probe.offered)}`);
  for (const id of wanted) console.log(`  ${probe.offered.includes(id) ? "[OK]  " : "[FAIL]"} ${id}`);
}
console.log("model probe done");
