import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendApproval, createApprovalsLink } from "@/permissions";

const REQ = {
  tool: "Bash",
  stage: "implementer",
  rule: "Bash",
  summary: "Bash command=bun run test",
  command: "bun run test",
};

async function seeded(dir: string) {
  const file = join(dir, "approvals.json");
  await appendApproval(file, {
    stage: "implementer",
    command: "bun run test",
    root: "/repo",
    origin: "escalate",
    matchedRule: null,
    approvedAt: "2026-09-22T10:00:00.000Z",
    approvedBy: "telegram:123",
    naxCommit: "7b37dbf74",
  });
  return file;
}

describe("approvals link", () => {
  test("an exact hit allows and attributes to cache", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["gated", "escalate"],
    });
    expect(await link.resolve(REQ)).toEqual({ decision: "allow", decidedBy: "cache" });
    cleanupTempDir(dir);
  });

  test("a miss ABSTAINS so the human is still asked", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["escalate"],
    });
    const out = await link.resolve({ ...REQ, command: "bun run test --x" });
    expect(out.decision).toBe("abstain");
    cleanupTempDir(dir);
  });

  test("PRECONDITION 1: any raw stage disables the cache entirely", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["escalate", "raw"],
    });
    // The entry matches exactly, and it is STILL not honoured.
    expect((await link.resolve(REQ)).decision).toBe("abstain");
    cleanupTempDir(dir);
  });

  test("PRECONDITION 2: an approvals file inside repoRoot disables the cache", async () => {
    const repoRoot = makeTempDir("repo-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(repoRoot),
      repoRoot,
      stageModes: ["escalate"],
    });
    expect((await link.resolve(REQ)).decision).toBe("abstain");
    cleanupTempDir(repoRoot);
  });

  test("a request with no command abstains", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["escalate"],
    });
    const { command: _omit, ...noCommand } = REQ;
    expect((await link.resolve(noCommand)).decision).toBe("abstain");
    cleanupTempDir(dir);
  });
});
