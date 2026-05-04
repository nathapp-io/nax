import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
// Direct node:fs/promises is used here because writeProjectIdentity writes to ~/.nax/<key>/
// which is outside os.tmpdir() — the test/helpers/temp.ts helpers only manage tmpdir paths.
import { rm, mkdir } from "node:fs/promises";
import { writeProjectIdentity } from "../../../src/runtime";
import { validateProjectName, checkInitCollision } from "../../../src/cli/init";

describe("validateProjectName", () => {
  it("accepts 'my-project'", () => {
    const r = validateProjectName("my-project");
    expect(r.valid).toBe(true);
  });

  it("rejects empty string", () => {
    const r = validateProjectName("");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("non-empty");
  });

  it("rejects 'global'", () => {
    const r = validateProjectName("global");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name with uppercase", () => {
    const r = validateProjectName("MyProject");
    expect(r.valid).toBe(false);
  });

  it("rejects name starting with '_'", () => {
    const r = validateProjectName("_archive");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("reserved");
  });

  it("rejects name longer than 64 chars", () => {
    const r = validateProjectName("a".repeat(65));
    expect(r.valid).toBe(false);
  });
});

const TEST_KEY = "__nax_test_init_collision__";

describe("checkInitCollision", () => {
  const identityDir = path.join(os.homedir(), ".nax", TEST_KEY);

  beforeEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
    await mkdir(identityDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  it("returns no collision when identity does not exist", async () => {
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", null);
    expect(result.collision).toBe(false);
  });

  it("returns no collision when workdir matches (no-remote case)", async () => {
    await writeProjectIdentity(TEST_KEY, {
      name: TEST_KEY,
      workdir: "/tmp/my-project",
      remoteUrl: null,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", null);
    expect(result.collision).toBe(false);
  });

  it("returns no collision when remote URL matches", async () => {
    const remote = "git@github.com:org/repo.git";
    await writeProjectIdentity(TEST_KEY, {
      name: TEST_KEY,
      workdir: "/tmp/other-project",
      remoteUrl: remote,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", remote);
    expect(result.collision).toBe(false);
  });

  it("returns collision when different workdir and no remote", async () => {
    await writeProjectIdentity(TEST_KEY, {
      name: TEST_KEY,
      workdir: "/tmp/other-project",
      remoteUrl: null,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    const result = await checkInitCollision(TEST_KEY, "/tmp/my-project", null);
    expect(result.collision).toBe(true);
    expect(result.existing?.workdir).toBe("/tmp/other-project");
  });
});
