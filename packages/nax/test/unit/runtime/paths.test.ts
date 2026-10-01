import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNaxError } from "@test/helpers";
import { globalConfigDir } from "@/config/paths";
import { NaxError } from "@/errors";
import {
  claimProjectIdentity,
  curatorRollupPath,
  globalOutputDir,
  identityPath,
  type ProjectIdentity,
  projectInputDir,
  projectOutputDir,
  readProjectIdentity,
  writeProjectIdentity,
} from "@/runtime";

describe("projectInputDir", () => {
  it("returns workdir/.nax", () => {
    expect(projectInputDir("/home/user/myproject")).toBe("/home/user/myproject/.nax");
  });
});

describe("projectOutputDir", () => {
  it("defaults to ~/.nax/<projectKey> when no outputDir override", () => {
    const result = projectOutputDir("myproject", undefined);
    expect(result).toBe(path.join(globalConfigDir(), "myproject"));
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
    expect(globalOutputDir()).toBe(path.join(globalConfigDir(), "global"));
  });
});

describe("identity I/O", () => {
  const TEST_PROJECT_KEY = "__nax_test_paths_identity__";
  const identDir = path.join(globalConfigDir(), TEST_PROJECT_KEY);

  beforeEach(async () => {
    await rm(identDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(identDir, { recursive: true, force: true });
  });

  it("identityPath returns correct path and readProjectIdentity returns null when file absent", async () => {
    expect(identityPath(TEST_PROJECT_KEY)).toBe(path.join(globalConfigDir(), TEST_PROJECT_KEY, ".identity"));
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
    await Bun.write(path.join(identDir, ".identity"), JSON.stringify({ name: TEST_PROJECT_KEY }));
    const result = await readProjectIdentity(TEST_PROJECT_KEY);
    expect(result).toBeNull();
  });
});

describe("curatorRollupPath", () => {
  it.each([
    [
      "no override (defaults to globalDir/curator/rollup.jsonl)",
      undefined,
      "/home/user/.nax/global/curator/rollup.jsonl",
    ],
    ["absolute path override", "/mnt/team/rollup.jsonl", "/mnt/team/rollup.jsonl"],
  ] as const)("%s", (_label, override, expected) => {
    expect(curatorRollupPath("/home/user/.nax/global", override)).toBe(expected);
  });

  it("expands tilde in override", () => {
    const result = curatorRollupPath("/home/user/.nax/global", "~/custom/rollup.jsonl");
    expect(result).toBe(path.join(os.homedir(), "custom/rollup.jsonl"));
  });

  it("throws NaxError for relative override", () => {
    expect(() => curatorRollupPath("/home/user/.nax/global", "relative/path")).toThrow(NaxError);
  });
});

const TEST_CLAIM_KEY = "__nax_test_claim_identity__";

describe("claimProjectIdentity", () => {
  const identityDir = path.join(globalConfigDir(), TEST_CLAIM_KEY);

  beforeEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  it("writes identity on first call", async () => {
    await claimProjectIdentity(TEST_CLAIM_KEY, "/tmp/my-project", null);
    const identity = await readProjectIdentity(TEST_CLAIM_KEY);
    expect(identity).not.toBeNull();
    expect(identity?.workdir).toBe("/tmp/my-project");
    expect(identity?.name).toBe(TEST_CLAIM_KEY);
  });

  it("throws RUN_NAME_COLLISION when a different workdir claims the same key", async () => {
    await claimProjectIdentity(TEST_CLAIM_KEY, "/tmp/my-project", null);
    const err = await claimProjectIdentity(TEST_CLAIM_KEY, "/tmp/other-project", null).catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("RUN_NAME_COLLISION");
  });

  it("updates lastSeen on subsequent calls for same workdir", async () => {
    await claimProjectIdentity(TEST_CLAIM_KEY, "/tmp/my-project", null);
    const first = await readProjectIdentity(TEST_CLAIM_KEY);
    await claimProjectIdentity(TEST_CLAIM_KEY, "/tmp/my-project", null);
    const second = await readProjectIdentity(TEST_CLAIM_KEY);
    expect(Date.parse(second?.lastSeen ?? "")).toBeGreaterThanOrEqual(Date.parse(first?.lastSeen ?? ""));
    expect(second?.createdAt).toBe(first?.createdAt);
  });
});

describe("claimProjectIdentity (US-004 — worktree branch identity)", () => {
  const KEY = "__nax_test_claim_identity_us004__";
  const identityDir = path.join(globalConfigDir(), KEY);

  beforeEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  it("updates lastSeen without throwing when workdir differs but normalized remotes match (ssh vs https)", async () => {
    await claimProjectIdentity(KEY, "/tmp/original-checkout", "git@github.com:o/r.git");
    const first = await readProjectIdentity(KEY);
    await claimProjectIdentity(KEY, "/tmp/other-worktree", "https://github.com/o/r");

    const second = await readProjectIdentity(KEY);
    expect(second).not.toBeNull();
    expect(Date.parse(second?.lastSeen ?? "")).toBeGreaterThanOrEqual(Date.parse(first?.lastSeen ?? ""));
  });

  it("leaves the stored workdir unchanged when workdir differs but remotes match", async () => {
    await claimProjectIdentity(KEY, "/tmp/original-checkout", "https://github.com/o/r.git");

    await claimProjectIdentity(KEY, "/tmp/other-worktree", "https://github.com/o/r.git");

    const stored = await readProjectIdentity(KEY);
    expect(stored?.workdir).toBe("/tmp/original-checkout");
  });

  it("throws RUN_NAME_COLLISION when remotes differ after normalization (different repos)", async () => {
    await claimProjectIdentity(KEY, "/tmp/original", "https://github.com/o/r.git");
    const err = await claimProjectIdentity(KEY, "/tmp/other", "https://github.com/o/other-repo.git").catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("RUN_NAME_COLLISION");
  });

  it("throws RUN_NAME_COLLISION when remotes are on different hosts but the path matches", async () => {
    await claimProjectIdentity(KEY, "/tmp/original", "https://github.com/o/r.git");
    const err = await claimProjectIdentity(KEY, "/tmp/other", "https://gitlab.com/o/r.git").catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("RUN_NAME_COLLISION");
  });

  it("throws RUN_NAME_COLLISION when both remotes are null and workdirs differ", async () => {
    await claimProjectIdentity(KEY, "/tmp/original", null);
    const err = await claimProjectIdentity(KEY, "/tmp/other", null).catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("RUN_NAME_COLLISION");
  });

  it("preserves name, workdir, remoteUrl, and createdAt when workdir and remote match", async () => {
    await claimProjectIdentity(KEY, "/tmp/workdir", "https://github.com/o/r.git");
    const before = await readProjectIdentity(KEY);
    await claimProjectIdentity(KEY, "/tmp/workdir", "https://github.com/o/r.git");

    const after = await readProjectIdentity(KEY);
    expect(after?.name).toBe(before?.name);
    expect(after?.workdir).toBe(before?.workdir);
    expect(after?.remoteUrl).toBe(before?.remoteUrl);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(Date.parse(after?.lastSeen ?? "")).toBeGreaterThanOrEqual(Date.parse(before?.lastSeen ?? ""));
  });

  it("updates lastSeen when the registered workdir is matched and remoteUrl is null", async () => {
    await claimProjectIdentity(KEY, "/tmp/workdir", null);
    const first = await readProjectIdentity(KEY);
    await claimProjectIdentity(KEY, "/tmp/workdir", null);

    const second = await readProjectIdentity(KEY);
    expect(Date.parse(second?.lastSeen ?? "")).toBeGreaterThanOrEqual(Date.parse(first?.lastSeen ?? ""));
  });

  it("accepts a null incoming remoteUrl when the registered remoteUrl is also null and workdirs match", async () => {
    await claimProjectIdentity(KEY, "/tmp/workdir", null);
    await claimProjectIdentity(KEY, "/tmp/workdir", null);
    const stored = await readProjectIdentity(KEY);
    expect(stored?.workdir).toBe("/tmp/workdir");
    expect(stored?.remoteUrl).toBeNull();
  });
});

import { NaxConfigSchema } from "@/config/schemas";

describe("NaxConfigSchema name field", () => {
  it.each([
    ["a valid name", { name: "my-project" }],
    ["a name with underscores and digits", { name: "proj_1" }],
    ["optional outputDir as absolute path", { name: "demo-app", outputDir: "/mnt/fast/nax/demo-app" }],
    ["outputDir starting with ~/", { name: "demo-app", outputDir: "~/custom/demo-app" }],
    ["curator.rollupPath", { name: "demo-app", curator: { rollupPath: "/mnt/share/rollup.jsonl" } }],
  ] as const)("accepts %s", (_label, input) => {
    expect(NaxConfigSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ["a name with uppercase letters", { name: "MyProject" }],
    ["reserved name 'global'", { name: "global" }],
    ["reserved name '_archive'", { name: "_archive" }],
    ["a name starting with '.'", { name: ".hidden" }],
    ["relative outputDir", { name: "demo-app", outputDir: "relative/path" }],
  ] as const)("rejects %s", (_label, input) => {
    expect(NaxConfigSchema.safeParse(input).success).toBe(false);
  });

  it("defaults name to empty string when absent", () => {
    const result = NaxConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("");
  });
});
