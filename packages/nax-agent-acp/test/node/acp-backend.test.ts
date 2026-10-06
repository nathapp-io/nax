/**
 * The ACP backend on real Node (the runtime the package ships to), against the
 * fake agent as a Node subprocess (type stripping, Node 22.19+).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createMemoryTranscriptStore,
  type EmbedderTool,
  isProcessAlive,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { afterEach, expect, test } from "vitest";
import { acpBackend } from "#src/client/index";
import { CLAUDE_CONFIG_OPTIONS } from "#test/fixtures/fake-agent/script";
import { FAKE_MAIN, fakeEnv, readRecords, startOf } from "#test/helpers/fake-process";

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

test("an ask approval round trip over a Node agent process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-ask-"));
  dirs.push(workdir);
  const record = join(workdir, "record.jsonl");
  const session = await createAgentSession({
    backend: acpBackend({
      agent: { name: "fake", command: process.execPath, args: [FAKE_MAIN] },
      allowUnsandboxed: true,
      env: fakeEnv(
        {
          turns: [
            {
              steps: [
                { kind: "permission", options: ["allow_once", "reject_once"] },
                { kind: "text", text: "ok" },
              ],
            },
          ],
        },
        record,
      ),
    }),
    profile: "ask",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("go")) {
    events.push(event);
    if (event.type === "approval_requested") session.answer(event.requestId, { decision: "allow" });
  }
  expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed" });
  await until(() => readRecords(record).some((r) => r.method === "permission-outcome"), 5_000);
  expect(readRecords(record).find((r) => r.method === "permission-outcome")?.params).toEqual({
    outcome: "selected",
    optionId: "opt-allow_once",
  });
  await session.close();
});

test("an embedder tool call from a Node agent process, over loopback HTTP MCP", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "acp-node-tools-"));
  dirs.push(workdir);
  const record = join(workdir, "record.jsonl");
  const ran: unknown[] = [];
  const lookup: EmbedderTool = {
    name: "lookup",
    description: "Look a word up",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    approval: "never",
    run: async (input) => {
      ran.push(input);
      return { content: "found" };
    },
  };
  const session = await createAgentSession({
    // A registry agent with an explicit command: claude's pre-approval, the fake's process.
    backend: acpBackend({
      agent: "claude",
      allowUnsandboxed: true,
      command: process.execPath,
      args: [FAKE_MAIN],
      env: fakeEnv(
        {
          configOptions: CLAUDE_CONFIG_OPTIONS,
          capabilities: { mcpCapabilities: { http: true } },
          turns: [
            {
              steps: [
                { kind: "mcpCall", tool: "lookup", input: { q: "node" } },
                { kind: "text", text: "done" },
              ],
            },
          ],
        },
        record,
      ),
    }),
    profile: "full",
    workdir,
    tools: [lookup],
    transcriptStore: createMemoryTranscriptStore(),
  });
  const events: SessionEvent[] = [];
  for await (const event of session.send("look it up")) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", status: "completed", output: "done" });
  expect(ran).toEqual([{ q: "node" }]);
  expect(readRecords(record).filter((r) => r.method === "mcp-result")).toMatchObject([
    { params: { tool: "lookup", result: { content: [{ type: "text", text: "found" }] } } },
  ]);
  await session.close();
});
