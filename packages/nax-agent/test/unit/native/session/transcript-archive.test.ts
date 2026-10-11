import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "#src/internal/redact";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import {
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  openNativeSession,
} from "#src/native/session/session";
import { _transcriptArchiveDeps } from "#src/native/session/transcript-archive";
import type { OpenSessionOpts } from "#src/session/session-types";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "transcript-archive-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

const LIVE_DOC = {
  savedAt: "2026-10-11T00:00:00.000Z",
  messages: [
    { role: "user", content: "hello" },
    { role: "tool-result", toolCallId: "t1", content: `key=${SECRET}` },
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
  test("disabled: no archive option keeps today's close behaviour and deletes the live transcript", async () => {
    const live = await tempDir();
    const { state, handle } = await openWithLive("s", live);
    await closeNativeSession(state, handle);
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
    expect(doc.messages).toEqual(redactSecrets(LIVE_DOC).messages);
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
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain('"toolCallId": "t1"');
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
    // A regular file cannot hold a child directory, so mkdir fails with ENOTDIR
    // even when running as root (unlike a chmod-based unwritable dir).
    const filePath = join(parent, "not-a-dir");
    await writeFile(filePath, "x");
    const { state, handle } = await openWithLive("s", live, {
      transcriptArchive: { dir: join(filePath, "archive"), maxRetained: 5 },
    });
    await expect(closeNativeSession(state, handle)).resolves.toBeUndefined();
    expect(await readdir(parent)).toEqual(["not-a-dir"]);
    expect(await readdir(live)).toEqual([]);
  });

  test("maxRetained 2 keeps only the two newest of three closes", async () => {
    const live = await tempDir();
    const archive = await tempDir();
    const origNow = _transcriptArchiveDeps.now;
    const created: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        // Distinct stamps without sleeping: each close gets its own injected second.
        _transcriptArchiveDeps.now = () => new Date(Date.UTC(2026, 9, 11, 0, 0, i));
        const before = await archived(archive);
        const { state, handle } = await openWithLive("s", live, {
          transcriptArchive: { dir: archive, maxRetained: 2 },
        });
        await closeNativeSession(state, handle);
        const fresh = (await archived(archive)).filter((f) => !before.includes(f));
        expect(fresh).toHaveLength(1);
        const name = fresh[0] as string;
        created.push(name);
        // Prune orders by mtime; pin an increasing past mtime so the order cannot tie.
        const t = new Date(Date.UTC(2020, 0, 1, 0, 0, i));
        await utimes(join(archive, name), t, t);
      }
    } finally {
      _transcriptArchiveDeps.now = origNow;
    }
    expect(new Set(created).size).toBe(3);
    const kept = await archived(archive);
    expect(kept.sort()).toEqual([created[1], created[2]].sort());
    expect(kept).not.toContain(created[0]);
  });
});
