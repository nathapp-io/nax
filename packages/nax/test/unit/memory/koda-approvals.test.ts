/**
 * koda-approvals.ts — the durable record of the saves koda answered with a 202,
 * so a rejected proposal can be reconciled on a later pull.
 *
 * Covers US-004 AC-1..AC-11.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { _kodaApprovalsDeps, createKodaApprovals, type KodaApproval } from "@/memory/koda-approvals";

const APR_1: KodaApproval = { approvalId: "apr_1", scope: "project", slug: "a", clientId: "c1" };
const APR_2: KodaApproval = { approvalId: "apr_2", scope: "project", slug: "b", clientId: "c2" };

describe("createKodaApprovals", () => {
  let dir: string;
  let logger: ReturnType<typeof makeLogger>;
  let originalDeps: typeof _kodaApprovalsDeps;

  const approvalsPath = (): string => join(dir, "koda-approvals.json");
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text());
  const warns = () => logger.calls.filter((call) => call.level === "warn");

  beforeEach(() => {
    dir = makeTempDir("nax-koda-approvals-");
    logger = makeLogger();
    originalDeps = { ..._kodaApprovalsDeps };
  });

  afterEach(() => {
    Object.assign(_kodaApprovalsDeps, originalDeps);
    cleanupTempDir(dir);
  });

  test("list resolves [] when the directory holds no koda-approvals.json (AC-1)", async () => {
    expect(await createKodaApprovals({ dir, logger }).list()).toEqual([]);
  });

  test("a recorded proposal is what list resolves (AC-2)", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    expect(await approvals.list()).toEqual([APR_1]);
  });

  test("the file holds the record under a version-1 approvals array (AC-3)", async () => {
    await createKodaApprovals({ dir, logger }).record(APR_1);
    expect(await readJson(approvalsPath())).toEqual({ version: 1, approvals: [APR_1] });
  });

  test("a second record over the same directory reads back through a new instance", async () => {
    await createKodaApprovals({ dir, logger }).record(APR_1);
    await createKodaApprovals({ dir, logger }).record(APR_2);
    expect(await createKodaApprovals({ dir, logger }).list()).toEqual([APR_1, APR_2]);
  });

  test("records keep the order they were made in, for the oldest-first resolution budget", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_2);
    await approvals.record(APR_1);
    expect((await approvals.list()).map((entry) => entry.approvalId)).toEqual(["apr_2", "apr_1"]);
  });

  test("recording for a scope and slug that already has one leaves only the new record (AC-4)", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    await approvals.record({ ...APR_1, approvalId: "apr_2" });
    expect(await approvals.list()).toEqual([{ ...APR_1, approvalId: "apr_2" }]);
    expect(await readJson(approvalsPath())).toEqual({ version: 1, approvals: [{ ...APR_1, approvalId: "apr_2" }] });
  });

  test("the same slug in both scopes leaves two records (AC-5)", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    await approvals.record({ ...APR_1, approvalId: "apr_user", scope: "user" });
    expect(await approvals.list()).toEqual([APR_1, { ...APR_1, approvalId: "apr_user", scope: "user" }]);
  });

  test("drop removes the named record and keeps the others (AC-6)", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    await approvals.record(APR_2);
    await approvals.drop(["apr_1"]);
    expect(await approvals.list()).toEqual([APR_2]);
    expect(await readJson(approvalsPath())).toEqual({ version: 1, approvals: [APR_2] });
  });

  test("drop keeps every record the named ids do not cover", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    await approvals.record(APR_2);
    await approvals.record({ ...APR_1, approvalId: "apr_3", slug: "c" });
    await approvals.drop(["apr_1", "apr_3"]);
    expect(await approvals.list()).toEqual([APR_2]);
  });

  test("drop of no ids keeps the file as it was", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    await approvals.drop([]);
    expect(await approvals.list()).toEqual([APR_1]);
  });

  test("a write goes to a temporary path in the directory and is renamed onto the file (AC-7)", async () => {
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const realWrite = _kodaApprovalsDeps.write;
    const realRename = _kodaApprovalsDeps.rename;
    _kodaApprovalsDeps.write = async (path, text) => {
      writes.push(path);
      await realWrite(path, text);
    };
    _kodaApprovalsDeps.rename = async (from, to) => {
      renames.push([from, to]);
      await realRename(from, to);
    };

    await createKodaApprovals({ dir, logger }).record(APR_1);

    expect(writes).toHaveLength(1);
    expect(renames).toEqual([[writes[0] ?? "", approvalsPath()]]);
    const tempPath = writes[0] ?? "";
    expect(tempPath).not.toBe(approvalsPath());
    expect(dirname(tempPath)).toBe(dir);
    expect(await readJson(approvalsPath())).toEqual({ version: 1, approvals: [APR_1] });
  });

  test("drop in a directory with no file writes nothing", async () => {
    await createKodaApprovals({ dir, logger }).drop(["apr_1"]);
    expect(await Bun.file(approvalsPath()).exists()).toBe(false);
  });

  test("drop rewrites an unusable file with the records it keeps", async () => {
    await Bun.write(approvalsPath(), "not json");
    await createKodaApprovals({ dir, logger }).drop(["apr_1"]);
    expect(await readJson(approvalsPath())).toEqual({ version: 1, approvals: [] });
  });

  test("a failed write rejects with MEMORY_KODA_APPROVALS_WRITE_FAILED and keeps the old records", async () => {
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    _kodaApprovalsDeps.rename = async () => {
      throw new Error("EXDEV: cross-device link");
    };

    await expect(approvals.record(APR_2)).rejects.toMatchObject({ code: "MEMORY_KODA_APPROVALS_WRITE_FAILED" });
    expect(await approvals.list()).toEqual([APR_1]);
  });

  test("a file holding not json resolves [] and logs one warn (AC-8)", async () => {
    await Bun.write(approvalsPath(), "not json");
    expect(await createKodaApprovals({ dir, logger }).list()).toEqual([]);
    expect(warns()).toHaveLength(1);
  });

  test("a file of another version resolves [] and logs one warn (AC-9)", async () => {
    await Bun.write(approvalsPath(), JSON.stringify({ version: 2, approvals: [APR_1] }));
    expect(await createKodaApprovals({ dir, logger }).list()).toEqual([]);
    expect(warns()).toHaveLength(1);
  });

  test("two list calls over one invalid file log the warn once (AC-10)", async () => {
    await Bun.write(approvalsPath(), "not json");
    const approvals = createKodaApprovals({ dir, logger });
    expect(await approvals.list()).toEqual([]);
    expect(await approvals.list()).toEqual([]);
    expect(warns()).toHaveLength(1);
  });

  test("a record after an unreadable file logs the warn once too", async () => {
    await Bun.write(approvalsPath(), "not json");
    const approvals = createKodaApprovals({ dir, logger });
    await approvals.record(APR_1);
    expect(await approvals.list()).toEqual([APR_1]);
    expect(warns()).toHaveLength(1);
  });

  test("an unreadable file resolves [] and logs one warn (AC-11)", async () => {
    mkdirSync(approvalsPath(), { recursive: true });
    const approvals = createKodaApprovals({ dir, logger });

    expect(await approvals.list()).toEqual([]);
    expect(await approvals.list()).toEqual([]);
    expect(warns()).toHaveLength(1);
  });

  test.each([
    ["approvals is an object", { version: 1, approvals: { apr_1: APR_1 } }],
    ["approvals is missing", { version: 1 }],
    ["a record is not an object", { version: 1, approvals: ["apr_1"] }],
    ["a record has no approvalId", { version: 1, approvals: [{ ...APR_1, approvalId: undefined }] }],
    ["a record has no slug", { version: 1, approvals: [{ ...APR_1, slug: 7 }] }],
    ["a record has an unknown scope", { version: 1, approvals: [{ ...APR_1, scope: "team" }] }],
    ["the file is an array", [APR_1]],
  ])("a version-1 file whose %s resolves [] and logs one warn (AC-11)", async (_label, content) => {
    await Bun.write(approvalsPath(), JSON.stringify(content));
    const approvals = createKodaApprovals({ dir, logger });

    expect(await approvals.list()).toEqual([]);
    expect(await approvals.list()).toEqual([]);
    expect(warns()).toHaveLength(1);
  });
});
