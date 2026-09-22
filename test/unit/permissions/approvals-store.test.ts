import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendApproval, findApproval, readApprovals } from "@/permissions";

const entry = (command: string, stage = "implementer") => ({
  stage,
  command,
  root: "/repo",
  origin: "escalate" as const,
  matchedRule: null,
  approvedAt: "2026-09-22T10:00:00.000Z",
  approvedBy: "telegram:123",
  naxCommit: "7b37dbf74",
});

describe("approvals store", () => {
  test("a missing file reads as empty, not an error", async () => {
    const dir = makeTempDir("approvals-");
    expect(await readApprovals(join(dir, "approvals.json"))).toEqual([]);
    cleanupTempDir(dir);
  });

  test("a malformed file reads as empty rather than throwing", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    writeFileSync(path, "{ this is not json");
    expect(await readApprovals(path)).toEqual([]);
    cleanupTempDir(dir);
  });

  test("append then read round-trips", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    await appendApproval(path, entry("bun run test"));
    const entries = await readApprovals(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBe("bun run test");
  });

  test("lookup is BYTE-EXACT: a prefix does not match a longer command", () => {
    const entries = [entry("bun run test")];
    expect(findApproval(entries, "implementer", "bun run test")).toBeDefined();
    expect(findApproval(entries, "implementer", "bun run test --reporter=./x")).toBeUndefined();
    expect(findApproval(entries, "implementer", "bun run test ")).toBeUndefined();
    expect(findApproval(entries, "implementer", "bun  run test")).toBeUndefined();
  });

  test("lookup is stage-scoped", () => {
    const entries = [entry("bun run test", "implementer")];
    expect(findApproval(entries, "verifier", "bun run test")).toBeUndefined();
  });

  test("a null element is dropped so a valid sibling still resolves without throwing", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    writeFileSync(path, JSON.stringify({ entries: [null, entry("bun run test")] }));
    const entries = await readApprovals(path);
    expect(entries).toHaveLength(1);
    expect(findApproval(entries, "implementer", "bun run test")).toBeDefined();
    cleanupTempDir(dir);
  });

  test("concurrent appends keep both entries and valid JSON", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    await Promise.all([appendApproval(path, entry("cmd-a")), appendApproval(path, entry("cmd-b"))]);
    const commands = (await readApprovals(path)).map((e) => e.command).sort();
    expect(commands).toEqual(["cmd-a", "cmd-b"]);
  });
});
