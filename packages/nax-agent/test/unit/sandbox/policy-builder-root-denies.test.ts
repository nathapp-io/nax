/**
 * #3038 -- srt resolves its mandatory write denies against the nax PROCESS cwd,
 * not the session root. `buildSandboxPolicy` therefore names them against the
 * root itself, so a session whose root is not the process cwd is still denied.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { realOrRaw } from "#src/internal/realpath";
import { SRT_MANDATORY_DENY_DIRS, SRT_MANDATORY_DENY_FILES } from "#src/sandbox/defaults";
import { buildSandboxPolicy, type SandboxPolicyInput } from "#src/sandbox/index";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import { candidatePaths } from "#src/sandbox/placeholder-paths";
import { stagingPlaceholderPaths } from "#src/sandbox/staging-placeholders";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";
import { naxOwnedPathsPolicy } from "#test/helpers/nax-owned-paths";

const NAMES = [...SRT_MANDATORY_DENY_FILES, ...SRT_MANDATORY_DENY_DIRS];

let base: string;
let root: string;
let elsewhere: string;

beforeEach(() => {
  base = realOrRaw(makeTempDir("sbx-root-denies-"));
  root = join(base, "repo");
  elsewhere = join(base, "elsewhere");
  mkdirSync(root, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
});
afterEach(() => cleanupTempDir(base));

function input(over: Partial<SandboxPolicyInput> = {}): SandboxPolicyInput {
  return {
    root,
    git: { kind: "main", gitDir: join(root, ".git") },
    gitGuardFiles: [],
    naxEntries: [],
    ownedPaths: naxOwnedPathsPolicy,
    projectStateDir: ".nax",
    credentialFiles: [],
    home: join(base, "home"),
    tempRoots: [join(base, "tmp")],
    platform: "linux",
    config: DEFAULT_SANDBOX_CONFIG,
    ...over,
  };
}

describe("buildSandboxPolicy: srt's mandatory names at the session root (#3038)", () => {
  test("every mandatory file and directory name is denied at the root, absent or not", () => {
    const policy = buildSandboxPolicy(input());
    for (const name of NAMES) expect(policy.denyWrite).toContain(join(root, name));
  });

  test("the denies hold on darwin too: seatbelt anchors its own at the process cwd", () => {
    const policy = buildSandboxPolicy(input({ platform: "darwin" }));
    for (const name of NAMES) expect(policy.denyWrite).toContain(join(root, name));
  });

  test("the list has no duplicates and no glob character", () => {
    const { denyWrite } = buildSandboxPolicy(input());
    expect(new Set(denyWrite).size).toBe(denyWrite.length);
    expect(denyWrite.some((p) => /[*?[\]{}]/.test(p))).toBe(false);
  });

  test("an existing tracked file is denied under the same spelling as an absent one", () => {
    mkdirSync(join(root, ".vscode"));
    writeFileSync(join(root, ".vscode", "settings.json"), "{}\n");
    writeFileSync(join(root, ".mcp.json"), "{}\n");
    const { denyWrite } = buildSandboxPolicy(input());
    expect(denyWrite).toContain(join(root, ".vscode"));
    expect(denyWrite).toContain(join(root, ".mcp.json"));
  });
});

describe("buildSandboxPolicy: nested mandatory denies (#3038, Linux scan)", () => {
  test("the scanned nested names land in denyWrite, deduplicated against the top-level ones", () => {
    const nested = [join(root, "sub", ".mcp.json"), join(root, "sub", ".vscode"), join(root, ".mcp.json")];
    const { denyWrite } = buildSandboxPolicy(input({ nestedMandatoryDenies: nested }));
    for (const p of nested) expect(denyWrite).toContain(p);
    expect(new Set(denyWrite).size).toBe(denyWrite.length);
  });

  test("absent: the list is exactly the top-level one", () => {
    expect(buildSandboxPolicy(input({ nestedMandatoryDenies: [] })).denyWrite).toEqual(
      buildSandboxPolicy(input()).denyWrite,
    );
  });
});

describe("placeholder candidates when the process cwd is not the session root (#3038)", () => {
  test("every absent mandatory name at the root is a candidate, though cwd is elsewhere", () => {
    const policy = buildSandboxPolicy(input());
    const candidates = candidatePaths(elsewhere, policy);
    for (const name of [".mcp.json", ".bashrc", ".vscode", ".idea", ".claude"]) {
      expect(candidates).toContain(join(root, name));
    }
  });

  test("a root name that exists is not a candidate: bwrap creates nothing there", () => {
    writeFileSync(join(root, ".mcp.json"), "{}\n");
    const candidates = candidatePaths(elsewhere, buildSandboxPolicy(input()));
    expect(candidates).not.toContain(join(root, ".mcp.json"));
  });
});

describe("staging guard when the process cwd is not the session root (#3038)", () => {
  withDepsRestore(_placeholderDeps);

  test("a placeholder at the root is excluded from the root's own staging pass", () => {
    const placeholder = join(root, ".bashrc");
    writeFileSync(placeholder, "");
    chmodSync(placeholder, 0o444);
    // US-004: the mandatory names are a Linux source, so pin the platform that
    // creates the placeholder rather than inheriting the host's.
    _placeholderDeps.platform = () => "linux";
    const previous = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(stagingPlaceholderPaths(root, [])).toEqual([".bashrc"]);
    } finally {
      process.chdir(previous);
    }
  });
});
