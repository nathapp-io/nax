/**
 * The ACP backend on real Node (the runtime the package ships to), against the
 * fake agent as a Node subprocess (type stripping, Node 22.19+).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createMemoryTranscriptStore, isProcessAlive, type SessionEvent } from "@nathapp/nax-agent";
import { afterEach, expect, test } from "vitest";
import { acpBackend } from "#src/client/index";
import { FAKE_MAIN, fakeEnv, startOf } from "#test/helpers/fake-process";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a text turn and close over a Node agent process", async () => {
  expect(process.versions.bun).toBeUndefined();
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-"));
  dirs.push(workdir);
  const record = join(workdir, "record.jsonl");
  const session = await createAgentSession({
    backend: acpBackend({
      agent: { name: "fake", command: process.execPath, args: [FAKE_MAIN] },
      allowUnsandboxed: true,
      env: fakeEnv({ turns: [{ steps: [{ kind: "text", text: "node-pong" }] }] }, record),
    }),
    profile: "full",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("ping")) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed", output: "node-pong" });
  const { pid } = startOf(record);
  await session.close();
  await until(() => !isProcessAlive(pid), 5_000);
});
