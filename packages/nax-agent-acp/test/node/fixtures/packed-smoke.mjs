/**
 * nax-agent-acp tarball smoke (S4 spec §9, §11.1). Runs in a clean Node project
 * that installed the packed @nathapp/nax-agent and @nathapp/nax-agent-acp, with
 * the fake ACP agent copied next to it: a turn, a close, a resume in a new agent
 * process, a second turn.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createFileTranscriptStore, resumeAgentSession } from "@nathapp/nax-agent";
import { acpBackend } from "@nathapp/nax-agent-acp/client";

assert.equal(process.versions.bun, undefined, "the packed smoke must run on native Node");

const fakeMain = fileURLToPath(new URL("./fake-agent/main.ts", import.meta.url));
const workdir = mkdtempSync(join(tmpdir(), "acp-packed-"));
const storeDir = mkdtempSync(join(tmpdir(), "acp-packed-store-"));
const record = join(workdir, "record.jsonl");
const script = {
  capabilities: { sessionCapabilities: { resume: {} } },
  turns: [{ steps: [{ kind: "text", text: "packed-pong" }] }],
  relaunch: { turns: [{ steps: [{ kind: "text", text: "packed-again" }] }] },
};

const options = () => ({
  backend: acpBackend({
    agent: { name: "fake", command: process.execPath, args: [fakeMain] },
    allowUnsandboxed: true,
    env: { PATH: process.env.PATH ?? "", FAKE_AGENT_SCRIPT: JSON.stringify(script), FAKE_AGENT_RECORD: record },
  }),
  profile: "full",
  workdir,
  transcriptStore: createFileTranscriptStore(storeDir),
  sessionId: "packed-1",
});

async function turn(session, message) {
  let end;
  for await (const event of session.send(message)) end = event;
  return end;
}

try {
  const first = await createAgentSession(options());
  const end1 = await turn(first, "ping");
  assert.equal(end1.status, "completed", JSON.stringify(end1.error));
  assert.equal(end1.output, "packed-pong");
  await first.close();

  const second = await resumeAgentSession("packed-1", options());
  assert.equal(second.backend.capabilities.restoredWith, "resume");
  const end2 = await turn(second, "again");
  assert.equal(end2.status, "completed", JSON.stringify(end2.error));
  assert.equal(end2.output, "packed-again");
  await second.close();
} finally {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
}
console.log("packed smoke ok");
