import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "#src/config/schemas-sandbox";
import { realOrRaw } from "#src/internal/realpath";
import { SRT_MACOS_TMPDIR_DENIES } from "#src/sandbox/defaults";
import { buildSandboxPolicy, type SandboxPolicyInput } from "#src/sandbox/index";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const GLOB = /[*?[\]{}]/;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realOrRaw(makeTempDir("sbx-policy-"));
  root = join(base, "repo");
  home = join(base, "home");
  mkdirSync(join(root, ".nax", "features", "f1"), { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => cleanupTempDir(base));

function input(over: Partial<SandboxPolicyInput> = {}): SandboxPolicyInput {
  return {
    root,
    git: { kind: "main", gitDir: join(root, ".git") },
    gitGuardFiles: [],
    naxEntries: ["config.json", "features", "rules", "scratchpad", "cache"],
    credentialFiles: [join(base, "gnax", "credentials"), join(base, "gnax", "credentials-bak-2")],
    home,
    tempRoots: [join(base, "tmp")],
    platform: "linux",
    config: DEFAULT_SANDBOX_CONFIG,
    ...over,
  };
}

describe("buildSandboxPolicy", () => {
  test("F1: no denyWrite or denyRead entry contains a glob character", () => {
    const policy = buildSandboxPolicy(input());
    for (const p of [...policy.denyWrite, ...policy.denyRead, ...policy.writeRoots]) expect(p).not.toMatch(GLOB);
  });

  test("every emitted path is absolute", () => {
    const policy = buildSandboxPolicy(input());
    for (const p of [...policy.denyWrite, ...policy.denyRead, ...policy.writeRoots])
      expect(p.startsWith("/")).toBe(true);
  });

  test("protected nax paths are literal denies", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite).toContain(join(root, ".nax", "config.json"));
    expect(policy.denyWrite).toContain(join(root, ".nax", "mono"));
    expect(policy.denyWrite).toContain(join(root, ".queue.txt"));
    expect(policy.denyWrite).toContain(join(root, ".queue.txt.processing"));
  });

  test("#2260: every top-level .nax entry except the scratchpad is denied whole", () => {
    const policy = buildSandboxPolicy(input());
    for (const name of ["config.json", "features", "rules", "cache"]) {
      expect(policy.denyWrite).toContain(join(root, ".nax", name));
    }
    expect(policy.denyWrite).not.toContain(join(root, ".nax", "scratchpad"));
  });

  test("#2260: one features deny replaces the per-feature prd.json denies", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite.filter((p) => p.startsWith(join(root, ".nax", "features")))).toEqual([
      join(root, ".nax", "features"),
    ]);
  });

  test("#2260: every entry nax loads as input is denied even when absent (rules, hooks, plugins, prompt templates)", () => {
    const policy = buildSandboxPolicy(input({ naxEntries: [] }));
    for (const name of [
      "config.json",
      "mono",
      "rules",
      "context.md",
      "hooks.json",
      "plugins",
      "templates",
      "prompts",
    ]) {
      expect(policy.denyWrite).toContain(join(root, ".nax", name));
    }
  });

  test("#2260: an allowWrite opt-in lifts exactly that entry's deny", () => {
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: [".nax/rules"], denyRead: [], allowSharedTmp: false },
    };
    const policy = buildSandboxPolicy(input({ config }));
    expect(policy.denyWrite).not.toContain(join(root, ".nax", "rules"));
    expect(policy.denyWrite).toContain(join(root, ".nax", "cache"));
  });

  test("#2260: features, config.json and mono stay denied even when listed in allowWrite", () => {
    const allowWrite = [".nax/features", ".nax/config.json", ".nax/mono"];
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite, denyRead: [], allowSharedTmp: false },
    };
    const policy = buildSandboxPolicy(input({ config }));
    for (const name of ["features", "config.json", "mono"])
      expect(policy.denyWrite).toContain(join(root, ".nax", name));
  });

  test("main checkout: hooks and config of the git dir are denied", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite).toContain(join(root, ".git", "hooks"));
    expect(policy.denyWrite).toContain(join(root, ".git", "config"));
    expect(policy.writeRoots).not.toContain(join(root, ".git"));
  });

  test("no git repo: no git denies at all", () => {
    const policy = buildSandboxPolicy(input({ git: { kind: "none" } }));
    expect(policy.denyWrite.some((p) => p.includes(join(root, ".git")))).toBe(false);
  });

  test("F2 + finding 4: a worktree gets its git write roots and every pointer denied", () => {
    const common = join(base, "main", ".git");
    const gitDir = join(common, "worktrees", "US-001");
    const policy = buildSandboxPolicy(input({ git: { kind: "worktree", gitDir, commonDir: common } }));
    expect(policy.writeRoots).toContain(gitDir);
    for (const p of [
      join(common, "hooks"),
      join(common, "config"),
      join(common, "config.worktree"),
      join(root, ".git"),
      join(gitDir, "gitdir"),
      join(gitDir, "commondir"),
      join(gitDir, "config.worktree"),
    ]) {
      expect(policy.denyWrite).toContain(p);
    }
  });

  test("#2211: a worktree writes only its own admin dir and the shared objects/refs/logs/reftable/lfs, never the common dir", () => {
    const common = join(base, "main", ".git");
    const gitDir = join(common, "worktrees", "US-001");
    const policy = buildSandboxPolicy(input({ git: { kind: "worktree", gitDir, commonDir: common } }));
    const gitRoots = policy.writeRoots.filter((p) => p === common || p.startsWith(`${common}/`));
    expect(gitRoots.sort()).toEqual(
      [
        gitDir,
        join(common, "objects"),
        join(common, "refs"),
        join(common, "logs"),
        // A reftable repo (extensions.refStorage=reftable) keeps every shared ref here.
        join(common, "reftable"),
        join(common, "lfs"),
      ].sort(),
    );
    // So the top-level redirect files and submodule git dirs fall outside every write root.
    for (const outside of [join(common, "commondir"), join(common, "modules"), join(common, "worktrees", "US-002")]) {
      expect(policy.writeRoots.some((r) => outside === r || outside.startsWith(`${r}/`))).toBe(false);
    }
  });

  test("#2198: main checkout denies config.worktree, which an empty srt stub leaves valid", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite).toContain(join(root, ".git", "config.worktree"));
  });

  test("#2198: main checkout never emits an absent commondir itself (srt would stub it empty and break git)", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite).not.toContain(join(root, ".git", "commondir"));
  });

  test("#2198: every git guard file (commondir, sibling worktree pointers) becomes a literal deny", () => {
    const common = join(base, "main", ".git");
    const gitDir = join(common, "worktrees", "US-001");
    const guards = [
      join(common, "commondir"),
      join(common, "worktrees", "US-002", "gitdir"),
      join(common, "worktrees", "US-002", "commondir"),
      join(common, "worktrees", "US-002", "config.worktree"),
      join(base, "main", ".nax-wt", "US-002", ".git"),
    ];
    const policy = buildSandboxPolicy(
      input({ git: { kind: "worktree", gitDir, commonDir: common }, gitGuardFiles: guards }),
    );
    for (const p of guards) expect(policy.denyWrite).toContain(p);
    expect(new Set(policy.denyWrite).size).toBe(policy.denyWrite.length);
  });

  test("US-006 AC13: the trust store is denied even when its parent is writable", () => {
    const trustStoreFile = join(home, ".nax", "trust.json");
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: ["~/.nax"], denyRead: [], allowSharedTmp: false },
    };
    const policy = buildSandboxPolicy(input({ config, trustStoreFile }));
    expect(policy.denyWrite).toContain(trustStoreFile);
  });

  test("US-006 AC14: no trust store input adds no undefined deny", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyWrite.some((path) => path === undefined)).toBe(false);
  });

  test("finding 5: the approvals file is always denied, even inside a write root", () => {
    const approvalsFile = join(home, ".cache", "nax", "approvals.json");
    const policy = buildSandboxPolicy(input({ approvalsFile }));
    expect(policy.writeRoots).toContain(join(home, ".cache"));
    expect(policy.denyWrite).toContain(approvalsFile);
  });

  test("write roots: root, temp roots, built-in caches; a SHARED macOS session adds /tmp/claude and ~/Library/Caches", () => {
    const linux = buildSandboxPolicy(input());
    expect(linux.writeRoots).toContain(root);
    expect(linux.writeRoots).toContain(join(base, "tmp"));
    expect(linux.writeRoots).toContain(join(home, ".bun", "install", "cache"));
    expect(linux.writeRoots).not.toContain(join(home, "Library", "Caches"));
    const mac = buildSandboxPolicy(input({ platform: "darwin" }));
    expect(mac.writeRoots).toContain(join(home, "Library", "Caches"));
    expect(mac.writeRoots).toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301: the deny list offers both the /tmp and the /private/tmp spelling", () => {
    // Measured 2026-09-30 on macOS with the project's srt 0.0.77: with
    // `/tmp/claude` present, EITHER spelling alone denies the write — srt
    // normalises a path that already exists. We emit the pair anyway because the
    // two collapse into one entry only by way of `realOrRaw`, and that depends on
    // the host: where `/tmp` is a real directory rather than a symlink to
    // `/private/tmp`, each spelling stands on its own.
    expect(SRT_MACOS_TMPDIR_DENIES).toEqual(["/tmp/claude", "/private/tmp/claude"]);
  });

  test("#2301: a confined darwin session denies both spellings of srt's forced TMPDIR", () => {
    const policy = buildSandboxPolicy(input({ platform: "darwin", confined: true }));
    for (const spelling of ["/tmp/claude", "/private/tmp/claude"])
      expect(policy.denyWrite).toContain(realOrRaw(spelling));
  });

  test("#2301: a confined darwin session drops /tmp/claude from its write roots", () => {
    const policy = buildSandboxPolicy(input({ platform: "darwin", confined: true }));
    expect(policy.writeRoots).not.toContain(realOrRaw("/tmp/claude"));
    // The other macOS-only root is unrelated to TMPDIR and stays.
    expect(policy.writeRoots).toContain(join(home, "Library", "Caches"));
  });

  test("#2301: a shared-temp darwin session gets no /tmp/claude deny", () => {
    // `confined` absent = shared roots = the opt-out posture; the write root is
    // still granted (the write-roots inventory test above covers that). No deny:
    // `defaultTempRoots` allows `/tmp` outright, so `/tmp/claude` sits inside an
    // allowed root and denying it would contradict the session's own denial hint.
    const policy = buildSandboxPolicy(input({ platform: "darwin" }));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
  });

  test("#2301: a confined linux session is untouched — bwrap needs its own check", () => {
    const policy = buildSandboxPolicy(input({ platform: "linux", confined: true }));
    expect(policy.denyWrite).not.toContain(realOrRaw("/tmp/claude"));
    expect(policy.denyWrite).not.toContain(realOrRaw("/private/tmp/claude"));
  });

  test("credential read denies: built-ins under home plus the listed nax credential files", () => {
    const policy = buildSandboxPolicy(input());
    expect(policy.denyRead).toContain(join(home, ".ssh"));
    expect(policy.denyRead).toContain(join(home, ".npmrc"));
    expect(policy.denyRead).toContain(join(base, "gnax", "credentials-bak-2"));
  });

  test("config extras: ~ expands, relative allowWrite resolves against the root", () => {
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: ["~/.cache/custom", "build-out"], denyRead: ["~/secrets"], allowSharedTmp: false },
    };
    const policy = buildSandboxPolicy(input({ config }));
    expect(policy.writeRoots).toContain(join(home, ".cache", "custom"));
    expect(policy.writeRoots).toContain(join(root, "build-out"));
    expect(policy.denyRead).toContain(join(home, "secrets"));
  });

  test("F1: config extras are pinned glob-free too", () => {
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: ["~/.cache/custom", "build-out"], denyRead: ["~/secrets"], allowSharedTmp: false },
    };
    const policy = buildSandboxPolicy(input({ config }));
    for (const p of [...policy.denyWrite, ...policy.denyRead, ...policy.writeRoots]) expect(p).not.toMatch(GLOB);
  });

  test("F1: a glob that bypassed the schema throws instead of reaching the backend", () => {
    const withAllow: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: ["out-*"], denyRead: [], allowSharedTmp: false },
    };
    const withDeny: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: [], denyRead: ["~/secret*"], allowSharedTmp: false },
    };
    expect(() => buildSandboxPolicy(input({ config: withAllow }))).toThrow(/glob/);
    expect(() => buildSandboxPolicy(input({ config: withDeny }))).toThrow(/glob/);
  });

  test("finding 3: a nonexistent deny under a symlinked parent is emitted in its resolved spelling", () => {
    const real = join(base, "real");
    mkdirSync(join(real, ".nax"), { recursive: true });
    const link = join(base, "link");
    symlinkSync(real, link);
    const policy = buildSandboxPolicy(input({ root: link, naxEntries: [] }));
    expect(policy.denyWrite).toContain(join(real, ".nax", "rules"));
    expect(policy.writeRoots).toContain(real);
  });

  test("network: absent allowedDomains is open (no key); a list passes through", () => {
    expect(buildSandboxPolicy(input()).network).toEqual({});
    const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, network: { allowedDomains: ["registry.npmjs.org"] } };
    expect(buildSandboxPolicy(input({ config })).network).toEqual({ allowedDomains: ["registry.npmjs.org"] });
  });

  test("no duplicates", () => {
    const policy = buildSandboxPolicy(input({ tempRoots: [join(base, "tmp"), join(base, "tmp")] }));
    expect(new Set(policy.writeRoots).size).toBe(policy.writeRoots.length);
  });
});
