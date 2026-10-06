/**
 * S4 acceptance §11.3: initialize plus session/new for each registered non-Claude
 * agent whose launch command is installed. No prompt is sent. Prints each agent's
 * capability record (or its error code) for the master plan's capability matrix.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createMemoryTranscriptStore } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

const AGENTS = [
  ["codex", "codex-acp"],
  ["gemini", "gemini"],
  ["opencode", "opencode"],
  ["pi", "pi-acp"],
];

const installed = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;

for (const [agent, command] of AGENTS) {
  if (!installed(command)) {
    console.log(`${agent}: not installed (${command} is not on PATH)`);
    continue;
  }
  const workdir = mkdtempSync(join(tmpdir(), `acp-init-${agent}-`));
  try {
    const session = await createAgentSession({
      backend: acpBackend({ agent, allowUnsandboxed: true, initializeTimeoutMs: 120_000 }),
      profile: "full",
      workdir,
      transcriptStore: createMemoryTranscriptStore(),
    });
    console.log(`${agent}: ${JSON.stringify(session.backend.capabilities)}`);
    await session.close();
  } catch (error) {
    console.log(`${agent}: ${error?.code ?? "error"} ${error?.message ?? String(error)}`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
console.log("init smoke done");
