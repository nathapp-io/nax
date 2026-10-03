import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSessionAdapter, nativeSessionStateOf } from "#src/native/session-adapter";
import type { OpenSessionOpts } from "#src/session/session-types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function opts(owner: string): Promise<OpenSessionOpts> {
  const dir = await mkdtemp(join(tmpdir(), "adapter-state-"));
  dirs.push(dir);
  return {
    agentName: "native",
    workdir: dir,
    transcriptDir: dir,
    transcriptOwner: owner,
    timeoutSeconds: 30,
    modelDef: { provider: "anthropic", model: "anthropic/claude-sonnet-5-5" },
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  };
}

describe("NativeSessionAdapter state ownership", () => {
  test("two adapters keep the same session name apart", async () => {
    const a = new NativeSessionAdapter();
    const b = new NativeSessionAdapter();
    const oa = await opts("a");
    const ob = await opts("b");
    await a.openSession("same", oa);
    await b.openSession("same", ob);
    expect(nativeSessionStateOf(a).transcriptDirs.get("same")).toBe(oa.transcriptDir);
    expect(nativeSessionStateOf(b).transcriptOwners.get("same")).toBe("b");
  });

  test("closePhysicalSession clears only this adapter's entry and deletes its clean transcript", async () => {
    const a = new NativeSessionAdapter();
    const b = new NativeSessionAdapter();
    const oa = await opts("a");
    await a.openSession("s", oa);
    await b.openSession("s", await opts("b"));
    await writeFile(
      join(oa.transcriptDir as string, "s.transcript.json"),
      JSON.stringify({ savedAt: "x", messages: [] }),
    );
    await a.closePhysicalSession("s");
    expect(nativeSessionStateOf(a).transcriptDirs.has("s")).toBe(false);
    expect(nativeSessionStateOf(b).transcriptDirs.has("s")).toBe(true);
    expect(await readdir(oa.transcriptDir as string)).not.toContain("s.transcript.json");
  });
});
