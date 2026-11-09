/**
 * koda-approvals-read.test.ts — the approvals record over a path the real
 * filesystem refuses to read (US-001 AC-17, AC-18).
 *
 * No seam is overridden here: a directory stands where `koda-approvals.json`
 * should be, so the read fails the way a permission error or a stray directory
 * does, and the record must refuse the write rather than replace what it could
 * not read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { createKodaApprovals, type KodaApproval } from "@/memory/koda-approvals";

const APR_1: KodaApproval = { approvalId: "apr_1", scope: "project", slug: "a", clientId: "c1" };

/** The NaxError `promise` rejects with; fails the test when it resolves instead. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  const caught: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(caught)}`);
  return caught;
}

describe("createKodaApprovals — a path that cannot be read", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-koda-approvals-unreadable-");
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("a record refuses a path that is a directory and leaves it a directory (US-001 AC-17, AC-18)", async () => {
    const path = join(dir, "koda-approvals.json");
    mkdirSync(path, { recursive: true });

    const error = await rejection(createKodaApprovals({ dir, logger: makeLogger() }).record(APR_1));

    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "MEMORY_KODA_APPROVALS_READ_FAILED", context: { retryable: true } });
    expect(statSync(path).isDirectory()).toBe(true);
  });
});
