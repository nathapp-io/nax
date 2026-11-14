/**
 * koda-refusals.ts — the bounded, lenient report of proposals koda refused.
 *
 * Covers US-002 AC-1..AC-24: dedupe by `approvalId`, the 7-day expiry both
 * `list()` applies on read and `record()` applies on write, the 20-entry cap,
 * the atomic temporary-file write, and a failure handling that warns instead of
 * throwing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import {
  type KodaRefusal as BarrelKodaRefusal,
  type KodaRefusals as BarrelKodaRefusals,
  type MemoryKodaRefusal as BarrelMemoryKodaRefusal,
  createKodaRefusals as barrelCreate,
  KODA_REFUSALS_FILE as barrelFile,
  KODA_REFUSALS_MAX as barrelMax,
  KODA_REFUSAL_REPORT_MS as barrelReportMs,
} from "@/memory";
import {
  _kodaRefusalsDeps,
  createKodaRefusals,
  KODA_REFUSAL_REPORT_MS,
  KODA_REFUSALS_FILE,
  KODA_REFUSALS_MAX,
  type KodaRefusal,
  type MemoryKodaRefusal,
} from "@/memory/koda-refusals";

/** An incoming entry: a refusal before the pull stamps it. */
type Incoming = Omit<KodaRefusal, "refusedAt">;

const T0 = Date.parse("2026-11-14T05:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const APR_1: Incoming = { approvalId: "apr_1", kind: "forget", scope: "project", slug: "x", status: "rejected" };
const APR_2: Incoming = { approvalId: "apr_2", kind: "save", scope: "user", slug: "y", status: "expired" };

/** A filesystem failure with the code the module reads. */
function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: failure`), { code });
}

/** A raw file entry, alive at `instant`, for the files a test writes itself. */
function refusalFixture(instant: number): KodaRefusal {
  return { ...APR_1, refusedAt: new Date(instant).toISOString() };
}

describe("createKodaRefusals", () => {
  let dir: string;
  let logger: ReturnType<typeof makeLogger>;
  let originalDeps: typeof _kodaRefusalsDeps;
  /** The injected clock's instant; the tests step it instead of sleeping. */
  let nowMs: number;

  const refusalsPath = (): string => join(dir, KODA_REFUSALS_FILE);
  const readJson = async (): Promise<unknown> => JSON.parse(await Bun.file(refusalsPath()).text());
  const rawRefusals = async (): Promise<readonly KodaRefusal[]> => {
    const file = (await readJson()) as { refusals?: readonly KodaRefusal[] };
    return file.refusals ?? [];
  };
  const writeRaw = async (refusals: readonly unknown[]): Promise<void> => {
    await Bun.write(refusalsPath(), JSON.stringify({ version: 1, refusals }));
  };
  const warns = () => logger.calls.filter((call) => call.level === "warn");
  const at = (msAgo: number): string => new Date(nowMs - msAgo).toISOString();
  const stamp = (): string => new Date(nowMs).toISOString();
  const refusal = (overrides: Partial<KodaRefusal> = {}): KodaRefusal => ({
    approvalId: "apr_stale",
    kind: "save",
    scope: "project",
    slug: "stale",
    status: "rejected",
    refusedAt: at(0),
    ...overrides,
  });
  const ids = (entries: readonly KodaRefusal[]): string[] => entries.map((entry) => entry.approvalId);

  const store = (): ReturnType<typeof createKodaRefusals> =>
    createKodaRefusals({ dir, logger, now: () => new Date(nowMs) });

  beforeEach(() => {
    dir = makeTempDir("nax-koda-refusals-");
    logger = makeLogger();
    originalDeps = { ..._kodaRefusalsDeps };
    nowMs = T0;
  });

  afterEach(() => {
    Object.assign(_kodaRefusalsDeps, originalDeps);
    cleanupTempDir(dir);
  });

  test("a recorded refusal is what list resolves, stamped with the clock's instant (AC-1)", async () => {
    const refusals = store();
    await refusals.record([APR_1]);

    const expected: KodaRefusal = { ...APR_1, refusedAt: stamp() };
    expect(await refusals.list()).toEqual([expected]);
    expect(await readJson()).toEqual({ version: 1, refusals: [expected] });
  });

  test("a directory with no refusals file resolves [] and logs nothing (AC-2)", async () => {
    expect(await store().list()).toEqual([]);
    expect(logger.calls).toEqual([]);
    expect(await Bun.file(refusalsPath()).exists()).toBe(false);
  });

  test("an approvalId already in the file keeps its one entry and its original refusedAt (AC-3)", async () => {
    const refusals = store();
    await refusals.record([APR_1]);
    nowMs = T0 + DAY_MS;
    await refusals.record([{ ...APR_1, slug: "renamed" }]);

    expect(await rawRefusals()).toEqual([{ ...APR_1, refusedAt: new Date(T0).toISOString() }]);
    expect(ids(await refusals.list())).toEqual(["apr_1"]);
  });

  test("recorded entries keep the order they were recorded in, after the earlier ones (AC-4)", async () => {
    const refusals = store();
    await refusals.record([APR_1]);
    await refusals.record([APR_2, { ...APR_1, approvalId: "apr_3", slug: "z" }]);

    expect(ids(await refusals.list())).toEqual(["apr_1", "apr_2", "apr_3"]);
  });

  test("list omits an entry older than the report window and keeps one exactly at it (AC-5)", async () => {
    await writeRaw([
      refusal({ approvalId: "apr_older", refusedAt: at(KODA_REFUSAL_REPORT_MS + 1) }),
      refusal({ approvalId: "apr_edge", refusedAt: at(KODA_REFUSAL_REPORT_MS) }),
    ]);

    expect(ids(await store().list())).toEqual(["apr_edge"]);
  });

  test("record prunes an expired entry from the raw file it writes (AC-6)", async () => {
    await writeRaw([refusal({ approvalId: "apr_stale", refusedAt: at(KODA_REFUSAL_REPORT_MS + 1) })]);
    await store().record([APR_1]);

    expect(ids(await rawRefusals())).toEqual(["apr_1"]);
  });

  test("25 recorded entries keep only the last 20, in list and in the file (AC-7)", async () => {
    const refusals = store();
    const incoming = Array.from({ length: 25 }, (_unused, index) => ({ ...APR_1, approvalId: `apr_${index}` }));
    await refusals.record(incoming);

    const kept = Array.from({ length: KODA_REFUSALS_MAX }, (_unused, index) => `apr_${index + 5}`);
    expect(ids(await refusals.list())).toEqual(kept);
    expect(ids(await rawRefusals())).toEqual(kept);
  });

  test("an expired entry does not take a slot from the 21 new records that follow it (AC-8)", async () => {
    await writeRaw([refusal({ approvalId: "apr_stale", refusedAt: at(KODA_REFUSAL_REPORT_MS + 1) })]);
    const incoming = Array.from({ length: 21 }, (_unused, index) => ({ ...APR_1, approvalId: `apr_${index}` }));
    const refusals = store();
    await refusals.record(incoming);

    const kept = Array.from({ length: KODA_REFUSALS_MAX }, (_unused, index) => `apr_${index + 1}`);
    expect(ids(await refusals.list())).toEqual(kept);
    expect(ids(await rawRefusals())).toEqual(kept);
  });

  test("record of no entries writes nothing (AC-9)", async () => {
    const writes: string[] = [];
    _kodaRefusalsDeps.write = async (path, text) => {
      writes.push(path);
      await Bun.write(path, text);
    };

    await store().record([]);

    expect(writes).toEqual([]);
    expect(await Bun.file(refusalsPath()).exists()).toBe(false);
  });

  test("a file that is not JSON resolves [] (AC-10)", async () => {
    await Bun.write(refusalsPath(), "not json");
    expect(await store().list()).toEqual([]);
  });

  test("two list calls over one invalid file log the unusable warn once (AC-11)", async () => {
    await Bun.write(refusalsPath(), "not json");
    const refusals = store();

    expect(await refusals.list()).toEqual([]);
    expect(await refusals.list()).toEqual([]);

    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.message).toBe("koda refusals file is unusable");
  });

  test("record over a file that is not JSON writes a version-1 file of only the incoming entries (AC-12)", async () => {
    await Bun.write(refusalsPath(), "not json");
    await store().record([APR_1]);

    expect(await readJson()).toEqual({ version: 1, refusals: [{ ...APR_1, refusedAt: stamp() }] });
  });

  test("a read that fails with EACCES resolves [] (AC-13)", async () => {
    _kodaRefusalsDeps.read = async () => {
      throw fsError("EACCES");
    };

    expect(await store().list()).toEqual([]);
  });

  test("a read that fails with EACCES logs the unusable warn once (AC-14)", async () => {
    _kodaRefusalsDeps.read = async () => {
      throw fsError("EACCES");
    };
    const refusals = store();

    expect(await refusals.list()).toEqual([]);
    expect(await refusals.list()).toEqual([]);

    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.message).toBe("koda refusals file is unusable");
  });

  test.each([
    ["version 2", JSON.stringify({ version: 2, refusals: [refusalFixture(T0)] })],
    ["an entry with no refusedAt", JSON.stringify({ version: 1, refusals: [APR_1] })],
  ])("a file of %s resolves [] (AC-15)", async (_label, content) => {
    await Bun.write(refusalsPath(), content);
    expect(await store().list()).toEqual([]);
  });

  test.each([
    ["version 2", JSON.stringify({ version: 2, refusals: [refusalFixture(T0)] })],
    ["an entry with no refusedAt", JSON.stringify({ version: 1, refusals: [APR_1] })],
  ])("a file of %s logs the unusable warn once (AC-16)", async (_label, content) => {
    await Bun.write(refusalsPath(), content);
    const refusals = store();

    expect(await refusals.list()).toEqual([]);
    expect(await refusals.list()).toEqual([]);

    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.message).toBe("koda refusals file is unusable");
  });

  test("two incoming entries of one approvalId store one entry for it (AC-17)", async () => {
    const refusals = store();
    await refusals.record([APR_1, APR_1]);

    expect(await refusals.list()).toEqual([{ ...APR_1, refusedAt: stamp() }]);
  });

  test("a rename that rejects does not make record throw (AC-18)", async () => {
    _kodaRefusalsDeps.rename = async () => {
      throw new Error("EXDEV: cross-device link");
    };
    const refusals = store();

    await expect(refusals.record([APR_1])).resolves.toBeUndefined();
  });

  test("a rename that rejects logs the not-recorded warn naming the path and the error (AC-19)", async () => {
    _kodaRefusalsDeps.rename = async () => {
      throw new Error("EXDEV: cross-device link");
    };

    await store().record([APR_1]);

    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.message).toBe("koda refusals were not recorded");
    expect(warns()[0]?.data?.path).toBe(refusalsPath());
    expect(String(warns()[0]?.data?.error)).toContain("EXDEV");
  });

  test("a rename that rejects leaves the original file unchanged (AC-20)", async () => {
    const refusals = store();
    await refusals.record([APR_1]);
    const before = await Bun.file(refusalsPath()).text();

    _kodaRefusalsDeps.rename = async () => {
      throw new Error("EXDEV: cross-device link");
    };
    await refusals.record([APR_2]);

    expect(await Bun.file(refusalsPath()).text()).toBe(before);
    expect(ids(await refusals.list())).toEqual(["apr_1"]);
  });

  test("record writes a temporary file in the directory and renames it onto koda-refusals.json (AC-21)", async () => {
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const realWrite = _kodaRefusalsDeps.write;
    const realRename = _kodaRefusalsDeps.rename;
    _kodaRefusalsDeps.write = async (path, text) => {
      writes.push(path);
      await realWrite(path, text);
    };
    _kodaRefusalsDeps.rename = async (from, to) => {
      renames.push([from, to]);
      await realRename(from, to);
    };

    await store().record([APR_1]);

    const tempPath = writes[0] ?? "";
    expect(writes).toHaveLength(1);
    expect(tempPath).not.toBe(refusalsPath());
    expect(dirname(tempPath)).toBe(dir);
    expect(renames).toEqual([[tempPath, refusalsPath()]]);
    expect(await readJson()).toEqual({ version: 1, refusals: [{ ...APR_1, refusedAt: stamp() }] });
  });

  test.each([
    ["another version", JSON.stringify({ version: 2, refusals: [refusalFixture(T0)] })],
    ["an entry missing refusedAt", JSON.stringify({ version: 1, refusals: [APR_1] })],
    ["an entry missing kind", JSON.stringify({ version: 1, refusals: [{ ...refusalFixture(T0), kind: undefined }] })],
    [
      "an entry with an unknown status",
      JSON.stringify({ version: 1, refusals: [{ ...refusalFixture(T0), status: "maybe" }] }),
    ],
  ])("record over a file holding %s writes only the incoming entries (AC-22)", async (_label, content) => {
    await Bun.write(refusalsPath(), content);
    await store().record([APR_1]);

    expect(await readJson()).toEqual({ version: 1, refusals: [{ ...APR_1, refusedAt: stamp() }] });
  });

  test("a read that fails with EACCES does not stop record writing the incoming entries (AC-23)", async () => {
    _kodaRefusalsDeps.read = async () => {
      throw fsError("EACCES");
    };

    await store().record([APR_1]);

    expect(await readJson()).toEqual({ version: 1, refusals: [{ ...APR_1, refusedAt: stamp() }] });
  });

  test("a write that rejects is warned about and never thrown (AC-24)", async () => {
    _kodaRefusalsDeps.write = async () => {
      throw new Error("ENOSPC: no space left on device");
    };

    await expect(store().record([APR_1])).resolves.toBeUndefined();

    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.message).toBe("koda refusals were not recorded");
    expect(warns()[0]?.data?.path).toBe(refusalsPath());
    expect(String(warns()[0]?.data?.error)).toContain("ENOSPC");
  });

  test("the barrel exports the refusals API (US-002 barrel)", () => {
    expect(barrelCreate).toBe(createKodaRefusals);
    expect(barrelFile).toBe(KODA_REFUSALS_FILE);
    expect(barrelMax).toBe(KODA_REFUSALS_MAX);
    expect(barrelReportMs).toBe(KODA_REFUSAL_REPORT_MS);
    expect(KODA_REFUSALS_FILE).toBe("koda-refusals.json");
    expect(KODA_REFUSALS_MAX).toBe(20);
    expect(KODA_REFUSAL_REPORT_MS).toBe(7 * DAY_MS);

    const statusEntry: BarrelMemoryKodaRefusal = { ...APR_1, refusedAt: stamp() };
    const fullEntry: BarrelKodaRefusal = { ...statusEntry, approvalId: "apr_1" };
    const handle: BarrelKodaRefusals = barrelCreate({ dir, logger, now: () => new Date(nowMs) });
    const listed: readonly MemoryKodaRefusal[] = [statusEntry, fullEntry];

    expect(listed).toHaveLength(2);
    expect(typeof handle.list).toBe("function");
  });
});
