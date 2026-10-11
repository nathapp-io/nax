import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  openNativeSession,
} from "#src/native/session/session";
import type { OpenSessionOpts } from "#src/session/session-types";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "transcript-archive-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(async (d) => {
      await chmod(d, 0o755).catch(() => {});
      await rm(d, { recursive: true, force: true });
    }),
  );
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

const LIVE_DOC = {
  savedAt: "2026-10-11T00:00:00.000Z",
  messages: [
    { role: "user", content: "hello" },
    { role: "tool", content: [{ type: "tool_result", toolCallId: "t1", output: `key=${SECRET}` }] },
  ],
};

function openOpts(dir: string, extra: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "native",
    workdir: dir,
    transcriptDir: dir,
    timeoutSeconds: 30,
    modelDef: { provider: "anthropic", model: "anthropic/claude-sonnet-5-5" },
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    ...extra,
  };
}

async function openWithLive(name: string, live: string, extra: Partial<OpenSessionOpts> = {}) {
  const state = createNativeSessionState();
  const handle = await openNativeSession(state, name, openOpts(live, extra));
  await writeFile(join(live, `${name}.transcript.json`), JSON.stringify(LIVE_DOC));
  return { state, handle };
}

const archived = async (dir: string) => (await readdir(dir)).filter((f) => f.startsWith("s.transcript.2"));

describe("transcript archive on close", () => {
  test("disabled: writes no archive and keeps today's close behaviour", async () => {
    const live = await tempDir();
    const archive = await tempDir();
    const { state, handle } = await openWithLive("s", live);
    await closeNativeSession(state, handle);
    expect(await readdir(archive)).toEqual([]);
    expect(await readdir(live)).toEqual([]);
  });

  test("clean close archives a redacted copy and deletes the live transcript", async () => {
    const live = await tempDir();
    const archive = await tempDir();
    const { state, handle } = await openWithLive("s", live, { transcriptArchive: { dir: archive, maxRetained: 5 } });
    await closeNativeSession(state, handle);
    const files = await archived(archive);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^s\.transcript\..+\.json$/);
    const doc = JSON.parse(await readFile(join(archive, files[0] as string), "utf8"));
    expect(doc.messages).toHaveLength(2);
    expect(doc.messages[0]).toEqual(LIVE_DOC.messages[0]);
    expect(await readdir(live)).toEqual([]);
  });

  test("failed close archives a copy and still renames the live transcript", async () => {
    const live = await tempDir();
    const archive = await tempDir();
    const { state, handle } = await openWithLive("s", live, { transcriptArchive: { dir: archive, maxRetained: 5 } });
    markNativeTurnOutcome(state, "s", true);
    await closeNativeSession(state, handle);
    expect(await archived(archive)).toHaveLength(1);
    const liveFiles = await readdir(live);
    expect(liveFiles).toHaveLength(1);
    expect(liveFiles[0]).toMatch(/^s\.transcript\.failed-/);
  });

  test("a secret in a tool result is masked in the archived file", async () => {
    const live = await tempDir();
    const archive = await tempDir();
    const { state, handle } = await openWithLive("s", live, { transcriptArchive: { dir: archive, maxRetained: 5 } });
    await closeNativeSession(state, handle);
    const files = await archived(archive);
    const raw = await readFile(join(archive, files[0] as string), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("tool_result");
  });

  test("retainOnClose writes no archive and keeps the live transcript", async () => {
    const live = await tempDir();
    const archive = await tempDir();
    const { state, handle } = await openWithLive("s", live, {
      retainOnClose: true,
      transcriptArchive: { dir: archive, maxRetained: 5 },
    });
    await closeNativeSession(state, handle);
    expect(await readdir(archive)).toEqual([]);
    expect(await readdir(live)).toEqual(["s.transcript.json"]);
  });

  test("a session that never saved closes without error and writes no archive", async () => {
    const archive = await tempDir();
    const store = createMemoryTranscriptStore();
    const state = createNativeSessionState();
    const handle = await openNativeSession(state, "s", {
      ...openOpts(archive),
      transcriptDir: undefined,
      transcriptStore: store,
      transcriptArchive: { dir: join(archive, "out"), maxRetained: 5 },
    });
    await closeNativeSession(state, handle);
    expect(await readdir(archive)).toEqual([]);
  });

  test("an unwritable archive dir does not change close semantics", async () => {
    const live = await tempDir();
    const parent = await tempDir();
    await chmod(parent, 0o500);
    const { state, handle } = await openWithLive("s", live, {
      transcriptArchive: { dir: join(parent, "nested", "out"), maxRetained: 5 },
    });
    await expect(closeNativeSession(state, handle)).resolves.toBeUndefined();
    expect(await readdir(live)).toEqual([]);
  });

  test("maxRetained 2 keeps only the two newest of three closes", async () => {
    const live = await tempDir();
    const archive = await tempDir();
    for (let i = 0; i < 3; i++) {
      const { state, handle } = await openWithLive("s", live, { transcriptArchive: { dir: archive, maxRetained: 2 } });
      await closeNativeSession(state, handle);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(await archived(archive)).toHaveLength(2);
  });
});
