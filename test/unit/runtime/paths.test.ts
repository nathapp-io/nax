import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NaxError } from "../../../src/errors";
import {
  globalOutputDir,
  projectInputDir,
  projectOutputDir,
  identityPath,
  readProjectIdentity,
  writeProjectIdentity,
  type ProjectIdentity,
} from "../../../src/runtime";

describe("projectInputDir", () => {
  it("returns workdir/.nax", () => {
    expect(projectInputDir("/home/user/myproject")).toBe("/home/user/myproject/.nax");
  });
});

describe("projectOutputDir", () => {
  it("defaults to ~/.nax/<projectKey> when no outputDir override", () => {
    const result = projectOutputDir("myproject", undefined);
    expect(result).toBe(path.join(os.homedir(), ".nax", "myproject"));
  });

  it("uses absolute outputDir override as-is", () => {
    const result = projectOutputDir("myproject", "/mnt/fast/nax/myproject");
    expect(result).toBe("/mnt/fast/nax/myproject");
  });

  it("expands tilde in outputDir override", () => {
    const result = projectOutputDir("myproject", "~/custom-nax/myproject");
    expect(result).toBe(path.join(os.homedir(), "custom-nax/myproject"));
  });

  it("throws NaxError for relative outputDir override", () => {
    expect(() => projectOutputDir("myproject", "relative/path")).toThrow(NaxError);
  });
});

describe("globalOutputDir", () => {
  it("returns ~/.nax/global", () => {
    expect(globalOutputDir()).toBe(path.join(os.homedir(), ".nax", "global"));
  });
});

describe("identity I/O", () => {
  const TEST_PROJECT_KEY = "__nax_test_paths_identity__";
  const identDir = path.join(os.homedir(), ".nax", TEST_PROJECT_KEY);

  beforeEach(async () => {
    await rm(identDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(identDir, { recursive: true, force: true });
  });

  it("identityPath returns correct path", () => {
    expect(identityPath(TEST_PROJECT_KEY)).toBe(
      path.join(os.homedir(), ".nax", TEST_PROJECT_KEY, ".identity"),
    );
  });

  it("readProjectIdentity returns null when file does not exist", async () => {
    const result = await readProjectIdentity(TEST_PROJECT_KEY);
    expect(result).toBeNull();
  });

  it("writeProjectIdentity then readProjectIdentity round-trips", async () => {
    await mkdir(identDir, { recursive: true });

    const identity: ProjectIdentity = {
      name: TEST_PROJECT_KEY,
      workdir: "/tmp/test-workdir",
      remoteUrl: "git@github.com:test/test.git",
      createdAt: "2026-05-04T00:00:00Z",
      lastSeen: "2026-05-04T01:00:00Z",
    };

    await writeProjectIdentity(TEST_PROJECT_KEY, identity);
    const read = await readProjectIdentity(TEST_PROJECT_KEY);
    expect(read).toEqual(identity);
  });

  it("readProjectIdentity returns null for malformed JSON file", async () => {
    await mkdir(identDir, { recursive: true });
    // Write malformed identity (missing required fields — shape guard should reject)
    await Bun.write(path.join(identDir, ".identity"), JSON.stringify({ name: TEST_PROJECT_KEY }));
    const result = await readProjectIdentity(TEST_PROJECT_KEY);
    expect(result).toBeNull();
  });
});
