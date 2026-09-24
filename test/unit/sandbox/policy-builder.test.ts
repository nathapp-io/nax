import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "@/config/schemas-sandbox";
import { buildSandboxPolicy, type SandboxPolicyInput } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

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
    featurePrdPaths: [join(root, ".nax", "features", "f1", "prd.json")],
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
    expect(policy.denyWrite).toContain(join(root, ".nax", "features", "f1", "prd.json"));
    expect(policy.denyWrite).toContain(join(root, ".queue.txt"));
    expect(policy.denyWrite).toContain(join(root, ".queue.txt.processing"));
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

  test("F2 + finding 4: a worktree gets the common dir writable and every pointer denied", () => {
    const common = join(base, "main", ".git");
    const gitDir = join(common, "worktrees", "US-001");
    const policy = buildSandboxPolicy(input({ git: { kind: "worktree", gitDir, commonDir: common } }));
    expect(policy.writeRoots).toContain(common);
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

  test("finding 5: the approvals file is always denied, even inside a write root", () => {
    const approvalsFile = join(home, ".cache", "nax", "approvals.json");
    const policy = buildSandboxPolicy(input({ approvalsFile }));
    expect(policy.writeRoots).toContain(join(home, ".cache"));
    expect(policy.denyWrite).toContain(approvalsFile);
  });

  test("write roots: root, temp roots, built-in caches; macOS adds /tmp/claude and ~/Library/Caches", () => {
    const linux = buildSandboxPolicy(input());
    expect(linux.writeRoots).toContain(root);
    expect(linux.writeRoots).toContain(join(base, "tmp"));
    expect(linux.writeRoots).toContain(join(home, ".bun", "install", "cache"));
    expect(linux.writeRoots).not.toContain(join(home, "Library", "Caches"));
    const mac = buildSandboxPolicy(input({ platform: "darwin" }));
    expect(mac.writeRoots).toContain(join(home, "Library", "Caches"));
    expect(mac.writeRoots).toContain(realOrRaw("/tmp/claude"));
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
      filesystem: { allowWrite: ["~/.cache/custom", "build-out"], denyRead: ["~/secrets"] },
    };
    const policy = buildSandboxPolicy(input({ config }));
    expect(policy.writeRoots).toContain(join(home, ".cache", "custom"));
    expect(policy.writeRoots).toContain(join(root, "build-out"));
    expect(policy.denyRead).toContain(join(home, "secrets"));
  });

  test("F1: config extras are pinned glob-free too", () => {
    const config: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: ["~/.cache/custom", "build-out"], denyRead: ["~/secrets"] },
    };
    const policy = buildSandboxPolicy(input({ config }));
    for (const p of [...policy.denyWrite, ...policy.denyRead, ...policy.writeRoots]) expect(p).not.toMatch(GLOB);
  });

  test("F1: a glob that bypassed the schema throws instead of reaching the backend", () => {
    const withAllow: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, filesystem: { allowWrite: ["out-*"], denyRead: [] } };
    const withDeny: SandboxConfig = {
      ...DEFAULT_SANDBOX_CONFIG,
      filesystem: { allowWrite: [], denyRead: ["~/secret*"] },
    };
    expect(() => buildSandboxPolicy(input({ config: withAllow }))).toThrow(/glob/);
    expect(() => buildSandboxPolicy(input({ config: withDeny }))).toThrow(/glob/);
  });

  test("finding 3: a nonexistent deny under a symlinked parent is emitted in its resolved spelling", () => {
    const real = join(base, "real");
    mkdirSync(join(real, ".nax", "features", "f9"), { recursive: true });
    const link = join(base, "link");
    symlinkSync(real, link);
    const policy = buildSandboxPolicy(
      input({ root: link, featurePrdPaths: [join(link, ".nax", "features", "f9", "prd.json")] }),
    );
    expect(policy.denyWrite).toContain(join(real, ".nax", "features", "f9", "prd.json"));
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
