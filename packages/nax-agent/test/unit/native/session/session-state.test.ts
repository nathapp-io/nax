import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearNativeSessionState,
  closeNativeSession,
  createNativeSessionState,
  markNativeTurnOutcome,
  openNativeSession,
  sessionAnchorFor,
} from "#src/native/session/session";
import type { OpenSessionOpts } from "#src/session/session-types";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "native-state-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function openOpts(transcriptDir: string, workdir: string): OpenSessionOpts {
  return {
    agentName: "native",
    workdir,
    transcriptDir,
    timeoutSeconds: 30,
    modelDef: { provider: "anthropic", model: "anthropic/claude-sonnet-5-5" },
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  };
}

describe("NativeSessionState", () => {
  test("two states keep the same session name apart", async () => {
    const a = createNativeSessionState();
    const b = createNativeSessionState();
    const dirA = await tempDir();
    const dirB = await tempDir();
    await openNativeSession(a, "s", { ...openOpts(dirA, dirA), transcriptOwner: "owner-a" });
    await openNativeSession(b, "s", { ...openOpts(dirB, dirB), transcriptOwner: "owner-b" });
    expect(a.transcriptDirs.get("s")).toBe(dirA);
    expect(b.transcriptDirs.get("s")).toBe(dirB);
    expect(a.transcriptOwners.get("s")).toBe("owner-a");
    expect(b.transcriptOwners.get("s")).toBe("owner-b");
  });

  test("clear empties every collection for one name only", async () => {
    const state = createNativeSessionState();
    const dir = await tempDir();
    await openNativeSession(state, "keep", openOpts(dir, dir));
    await openNativeSession(state, "drop", openOpts(dir, dir));
    state.lastUsage.set("drop", { promptTokens: 1, anchorIndex: 0 });
    markNativeTurnOutcome(state, "drop", true);
    clearNativeSessionState(state, "drop");
    for (const collection of [
      state.transcriptDirs,
      state.transcripts,
      state.scratchpadRoots,
      state.timeouts,
      state.streamHooks,
      state.failed,
      state.transcriptOwners,
      state.compaction,
      state.transportRetry,
      state.spinBreakers,
      state.lastUsage,
    ]) {
      expect(collection.has("drop")).toBe(false);
    }
    expect(state.transcriptDirs.has("keep")).toBe(true);
  });

  test("close on a failed turn retains the transcript; on success deletes it", async () => {
    const state = createNativeSessionState();
    const dir = await tempDir();
    const handle = await openNativeSession(state, "s", openOpts(dir, dir));
    await writeFile(join(dir, "s.transcript.json"), JSON.stringify({ savedAt: "x", messages: [] }));
    markNativeTurnOutcome(state, "s", true);
    await closeNativeSession(state, handle);
    expect((await readdir(dir)).some((f) => f.startsWith("s.transcript.failed-"))).toBe(true);
    expect(state.transcriptDirs.has("s")).toBe(false);
  });

  test("closing a name this state never opened touches nothing", async () => {
    const opener = createNativeSessionState();
    const other = createNativeSessionState();
    const dir = await tempDir();
    const handle = await openNativeSession(opener, "s", openOpts(dir, dir));
    await writeFile(join(dir, "s.transcript.json"), JSON.stringify({ savedAt: "x", messages: [] }));
    await closeNativeSession(other, handle);
    expect(await readdir(dir)).toContain("s.transcript.json");
    expect(opener.transcriptDirs.get("s")).toBe(dir);
  });

  test("sessionAnchorFor drops an anchor measured under another model", () => {
    const state = createNativeSessionState();
    state.lastUsage.set("s", { promptTokens: 10, anchorIndex: 2, model: "m1" });
    expect(sessionAnchorFor(state, "s", "m2")).toBeUndefined();
    expect(state.lastUsage.has("s")).toBe(false);
  });
});
