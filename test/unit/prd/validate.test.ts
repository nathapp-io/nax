import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrdCommitted, validateStoryId } from "@/prd";
import { _gitDeps } from "@/utils/git";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("validateStoryId", () => {
  test("accepts valid story IDs", () => {
    const validIds = [
      "auth-login",
      "US001",
      "feature_new_dashboard",
      "bug.fix.123",
      "api-v2-refactor",
      "a",
      "Z9",
      "test-with-many-chars-that-are-valid-123456789",
    ];

    for (const id of validIds) {
      expect(() => validateStoryId(id)).not.toThrow();
    }
  });

  test("rejects empty strings", () => {
    expect(() => validateStoryId("")).toThrow("Story ID cannot be empty");
  });

  test("rejects path traversal attempts", () => {
    expect(() => validateStoryId("../../../etc/passwd")).toThrow("Story ID cannot contain path traversal (..)");
    expect(() => validateStoryId("story..id")).toThrow("Story ID cannot contain path traversal (..)");
  });

  test("rejects git flags", () => {
    expect(() => validateStoryId("--force")).toThrow("Story ID cannot start with git flags (--)");
    expect(() => validateStoryId("--delete")).toThrow("Story ID cannot start with git flags (--)");
  });

  test("rejects IDs starting with non-alphanumeric", () => {
    expect(() => validateStoryId("-invalid")).toThrow(/pattern/);
    expect(() => validateStoryId("_invalid")).toThrow(/pattern/);
    expect(() => validateStoryId(".invalid")).toThrow(/pattern/);
  });

  test("rejects IDs with invalid characters", () => {
    expect(() => validateStoryId("invalid@id")).toThrow(/pattern/);
    expect(() => validateStoryId("invalid#id")).toThrow(/pattern/);
    expect(() => validateStoryId("invalid/id")).toThrow(/pattern/);
    expect(() => validateStoryId("invalid id")).toThrow(/pattern/);
  });

  test("rejects IDs longer than 64 characters", () => {
    const longId = "a" + "b".repeat(64); // 65 characters
    expect(() => validateStoryId(longId)).toThrow(/pattern/);
  });

  test("accepts IDs exactly 64 characters", () => {
    const id64 = "a" + "b".repeat(63); // 64 characters
    expect(() => validateStoryId(id64)).not.toThrow();
  });
});

// ── US-004 AC-8, AC-9: PRD-tracking guard ────────────────────────────────────

async function initGitRepo(root: string): Promise<void> {
  for (const args of [
    ["init"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test User"],
  ]) {
    const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  }
}

async function commitAll(root: string, message: string): Promise<void> {
  const add = Bun.spawn(["git", "add", "-A"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  await add.exited;
  const commit = Bun.spawn(["git", "commit", "-m", message], { cwd: root, stdout: "pipe", stderr: "pipe" });
  await commit.exited;
}

describe("assertPrdCommitted", () => {
  let projectRoot: string;
  let prdPath: string;

  beforeEach(async () => {
    projectRoot = makeTempDir("prd-guard-test-");
    await initGitRepo(projectRoot);
    writeFileSync(join(projectRoot, "README.md"), "# test");
    await commitAll(projectRoot, "initial commit");

    const featureDir = join(projectRoot, ".nax", "features", "my-feature");
    mkdirSync(featureDir, { recursive: true });
    prdPath = join(featureDir, "prd.json");
  });

  afterEach(() => {
    cleanupTempDir(projectRoot);
  });

  // AC-8: untracked prd.json rejects, naming the PRD path.
  test("US-004 AC8: rejects with an error naming the PRD path when prd.json is untracked", async () => {
    writeFileSync(prdPath, JSON.stringify({ feature: "my-feature", stories: [] }));
    // Deliberately not `git add`ed — untracked.

    await expect(assertPrdCommitted(prdPath, projectRoot)).rejects.toThrow(prdPath);
  });

  // AC-9: tracked but modified prd.json rejects, naming the PRD path.
  test("US-004 AC9: rejects with an error naming the PRD path when prd.json has uncommitted modifications", async () => {
    writeFileSync(prdPath, JSON.stringify({ feature: "my-feature", stories: [] }));
    await commitAll(projectRoot, "add prd.json");
    writeFileSync(prdPath, JSON.stringify({ feature: "my-feature", stories: [], dirty: true }));

    await expect(assertPrdCommitted(prdPath, projectRoot)).rejects.toThrow(prdPath);
  });

  // Success path: tracked and clean must not reject.
  test("US-004: does not reject when prd.json is tracked and has no uncommitted modifications", async () => {
    writeFileSync(prdPath, JSON.stringify({ feature: "my-feature", stories: [] }));
    await commitAll(projectRoot, "add prd.json");

    await expect(assertPrdCommitted(prdPath, projectRoot)).resolves.toBeUndefined();
  });
});

// ── US-004: fail-closed when `git status` itself cannot be determined ───────

describe("assertPrdCommitted — git status failure", () => {
  let origSpawn: typeof _gitDeps.spawn;

  beforeEach(() => {
    origSpawn = _gitDeps.spawn;
  });

  afterEach(() => {
    _gitDeps.spawn = origSpawn;
  });

  // A failed/timed-out `git status` returns exit code != 0 with empty
  // stdout, which must not be read as "clean" — that would let the bake-off
  // proceed when git cannot actually determine whether the PRD is modified.
  test("rejects when git status exits non-zero, even though stdout is empty", async () => {
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      // args[0] is the "git" executable itself — the subcommand is args[1].
      const isStatus = args[1] === "status";
      const bytes = new TextEncoder().encode("");
      return {
        stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(isStatus ? 1 : 0),
        kill: mock(() => {}),
      };
    }) as typeof _gitDeps.spawn;

    await expect(assertPrdCommitted("/repo/.nax/features/f/prd.json", "/repo")).rejects.toThrow(
      "/repo/.nax/features/f/prd.json",
    );
  });
});
