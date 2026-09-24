import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _approvalsTaintDeps,
  appendApproval,
  clearApprovalsTaint,
  isForgeCapable,
  prepareApprovalsStore,
  readApprovalsFile,
  taintApprovals,
} from "@/permissions";

const OWN_PID = 1000;
const OTHER_PID = 2000;

const entry = (command: string) => ({
  stage: "implementer",
  command,
  root: "/repo",
  origin: "escalate" as const,
  matchedRule: null,
  approvedAt: "2026-09-22T10:00:00.000Z",
  approvedBy: "telegram:123",
  naxCommit: "7b37dbf74",
});

const saved = { ..._approvalsTaintDeps };
afterEach(() => {
  Object.assign(_approvalsTaintDeps, saved);
});

function stubProcess(alive: boolean): void {
  _approvalsTaintDeps.pid = () => OWN_PID;
  _approvalsTaintDeps.isProcessAlive = () => alive;
}

async function taintedBy(file: string, pid: number): Promise<void> {
  _approvalsTaintDeps.pid = () => pid;
  await taintApprovals(file, "run-a");
}

describe("isForgeCapable", () => {
  test.each([
    { modes: ["escalate"], sandbox: false, expected: false },
    { modes: ["escalate", "raw"], sandbox: false, expected: true },
    { modes: ["escalate", "raw"], sandbox: true, expected: false },
    { modes: ["gated"], sandbox: true, expected: false },
  ])("modes=$modes sandbox=$sandbox -> $expected", ({ modes, sandbox, expected }) => {
    expect(isForgeCapable(modes, sandbox)).toBe(expected);
  });
});

describe("taintApprovals", () => {
  test("drops every entry and records the run and process", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await appendApproval(file, entry("bun run test"));
    await taintedBy(file, OTHER_PID);
    const store = await readApprovalsFile(file);
    expect(store.entries).toEqual([]);
    expect(store.taint?.runId).toBe("run-a");
    expect(store.taint?.pid).toBe(OTHER_PID);
    cleanupTempDir(dir);
  });

  test("a later append keeps the marker, so the store stays untrusted", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await taintedBy(file, OTHER_PID);
    await appendApproval(file, entry("bun run test"));
    const store = await readApprovalsFile(file);
    expect(store.taint).toBeDefined();
    expect(store.entries).toHaveLength(1);
    cleanupTempDir(dir);
  });

  test("a malformed marker still taints: it can only withhold trust", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    writeFileSync(file, JSON.stringify({ taint: "yes", entries: [entry("bun run test")] }));
    const store = await readApprovalsFile(file);
    expect(store.taint).toEqual({ since: "", runId: "", pid: undefined });
    cleanupTempDir(dir);
  });
});

describe("clearApprovalsTaint", () => {
  test("an untainted store is left as is", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await appendApproval(file, entry("bun run test"));
    stubProcess(false);
    expect(await clearApprovalsTaint(file, "run-b")).toBe("clean");
    expect((await readApprovalsFile(file)).entries).toHaveLength(1);
    cleanupTempDir(dir);
  });

  test("a taint from an exited process is cleared together with its entries", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await taintedBy(file, OTHER_PID);
    await appendApproval(file, entry("forged"));
    stubProcess(false);
    expect(await clearApprovalsTaint(file, "run-b")).toBe("cleared");
    expect(await readApprovalsFile(file)).toEqual({ entries: [], taint: undefined });
    cleanupTempDir(dir);
  });

  test("a taint held by a live forge-capable nax process is kept", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await taintedBy(file, OTHER_PID);
    stubProcess(true);
    expect(await clearApprovalsTaint(file, "run-b")).toBe("held");
    expect((await readApprovalsFile(file)).taint).toBeDefined();
    cleanupTempDir(dir);
  });

  test("a taint this process wrote in an earlier run is cleared even though it is alive", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await taintedBy(file, OWN_PID);
    stubProcess(true);
    expect(await clearApprovalsTaint(file, "run-b")).toBe("cleared");
    cleanupTempDir(dir);
  });

  test("a taint a sibling story of THIS run wrote is held", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await taintedBy(file, OWN_PID);
    stubProcess(true);
    expect(await clearApprovalsTaint(file, "run-a")).toBe("held");
    cleanupTempDir(dir);
  });
});

describe("prepareApprovalsStore", () => {
  const opts = (approvalsFile: string, forgeCapable: boolean) => ({
    approvalsFile,
    runId: "run-b",
    storyId: "US-001",
    forgeCapable,
  });

  test("a forge-capable run taints the store", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await appendApproval(file, entry("bun run test"));
    await prepareApprovalsStore(opts(file, true));
    const store = await readApprovalsFile(file);
    expect(store.taint?.runId).toBe("run-b");
    expect(store.entries).toEqual([]);
    cleanupTempDir(dir);
  });

  test("a trusted run clears an earlier run's taint", async () => {
    const dir = makeTempDir("taint-");
    const file = join(dir, "approvals.json");
    await taintedBy(file, OTHER_PID);
    stubProcess(false);
    await prepareApprovalsStore(opts(file, false));
    expect((await readApprovalsFile(file)).taint).toBeUndefined();
    cleanupTempDir(dir);
  });

  test("a store it cannot write does not throw", async () => {
    const dir = makeTempDir("taint-");
    // A directory where the file should be: every write fails.
    const file = join(dir, "approvals.json");
    await appendApproval(join(file, "nested.json"), entry("x"));
    await expect(prepareApprovalsStore(opts(file, true))).resolves.toBeUndefined();
    cleanupTempDir(dir);
  });
});
