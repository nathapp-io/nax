import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { makeFinishState, withTempDir } from "@test/helpers";
import { _checkpointDeps, checkpointPath, deserializeFinishState, writeCheckpoint } from "@/finish";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

const original = { ..._checkpointDeps };
afterEach(() => {
  Object.assign(_checkpointDeps, original);
  resetLogger();
});

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  resetLogger();
  initLogger({ level: "info", headless: true, useChalk: false });
  addSink((entry) => entries.push(entry));
  return entries;
}

describe("finish checkpoint (finish A §4.4)", () => {
  test("writes a version-3 state that round-trips, with no temp file left behind", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      const state = makeFinishState();
      await writeCheckpoint(audit, state);
      const parsed = deserializeFinishState(await readFile(checkpointPath(audit), "utf8"));
      expect(parsed.version).toBe(3);
      expect(parsed.feature).toBe(state.feature);
      expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("the path is <auditDir>/<runId>.checkpoint.json", () => {
    expect(checkpointPath({ auditDir: "/a/b", runId: "r9" })).toBe("/a/b/r9.checkpoint.json");
  });

  test("never throws when the directory cannot be written", async () => {
    await writeCheckpoint({ auditDir: "/dev/null/nope", runId: "r" }, makeFinishState());
  });

  test("atomic: the state is complete in a same-directory temp file when it is renamed into place", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      const seen: { from: string; to: string; finalVisible: boolean; tmpText: string }[] = [];
      const realRename = _checkpointDeps.rename;
      _checkpointDeps.rename = async (from, to) => {
        const finalVisible = (await readdir(dir)).includes("run-1.checkpoint.json");
        seen.push({ from, to, finalVisible, tmpText: await readFile(from, "utf8") });
        await realRename(from, to);
      };
      await writeCheckpoint(audit, makeFinishState());
      expect(seen).toHaveLength(1);
      const [call] = seen;
      expect(call?.to).toBe(checkpointPath(audit));
      expect(dirname(call?.from ?? "")).toBe(dir);
      expect(call?.from).not.toBe(call?.to);
      expect(call?.finalVisible).toBe(false);
      expect(deserializeFinishState(call?.tmpText ?? "").version).toBe(3);
    });
  });

  test("a failed rename leaves the earlier checkpoint intact, removes the temp file and logs under _run", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      await writeCheckpoint(audit, makeFinishState({ feature: "first" }));
      const logs = captureLogs();
      _checkpointDeps.rename = async () => {
        throw new Error("rename denied");
      };
      await writeCheckpoint(audit, makeFinishState({ feature: "second" }));
      expect(deserializeFinishState(await readFile(checkpointPath(audit), "utf8")).feature).toBe("first");
      expect(await readdir(dir)).toEqual(["run-1.checkpoint.json"]);
      const warn = logs.find((l) => l.level === "warn" && l.message.includes("checkpoint"));
      expect(Object.keys(warn?.data ?? {})[0]).toBe("storyId");
      expect(warn?.data?.storyId).toBe("_run");
      expect(JSON.stringify(warn?.data)).toContain("rename denied");
    });
  });

  test("a write that dies half-way leaves no partial file at the final path or as a temp file", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      _checkpointDeps.writeFile = async (path, text) => {
        await writeFile(path, text.slice(0, 10), "utf8");
        throw new Error("disk full");
      };
      await writeCheckpoint(audit, makeFinishState());
      expect(await readdir(dir)).toEqual([]);
    });
  });

  test("every write uses its own temp name, so concurrent writes cannot interleave", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      const tmps: string[] = [];
      const realWrite = _checkpointDeps.writeFile;
      _checkpointDeps.writeFile = async (path, text) => {
        tmps.push(path);
        await realWrite(path, text);
      };
      await Promise.all([
        writeCheckpoint(audit, makeFinishState({ feature: "a" })),
        writeCheckpoint(audit, makeFinishState({ feature: "b" })),
      ]);
      expect(new Set(tmps).size).toBe(2);
      expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      const parsed = deserializeFinishState(await readFile(checkpointPath(audit), "utf8"));
      expect(["a", "b"]).toContain(parsed.feature);
    });
  });

  test("the state is serialized before any I/O is awaited, so a later mutation cannot tear the checkpoint", async () => {
    await withTempDir(async (dir) => {
      const audit = { auditDir: dir, runId: "run-1" };
      const state = makeFinishState({ feature: "before" });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const realMkdir = _checkpointDeps.mkdir;
      _checkpointDeps.mkdir = async (path) => {
        await gate;
        await realMkdir(path);
      };
      const pending = writeCheckpoint(audit, state);
      state.feature = "after";
      release();
      await pending;
      expect(deserializeFinishState(await readFile(checkpointPath(audit), "utf8")).feature).toBe("before");
    });
  });

  test("a state that cannot be serialized is logged, not thrown", async () => {
    const logs = captureLogs();
    const state = makeFinishState();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await writeCheckpoint({ auditDir: "/dev/null/nope", runId: "r" }, { ...state, resolution: cyclic } as typeof state);
    expect(logs.some((l) => l.level === "warn" && l.data?.storyId === "_run")).toBe(true);
  });
});
