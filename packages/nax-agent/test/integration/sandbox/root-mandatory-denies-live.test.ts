/**
 * #3038 live: REAL srt, REAL launcher, the production `buildSandboxPolicy`.
 *
 * srt anchors its mandatory write denies at `process.cwd()`. With the process cwd
 * elsewhere, a session root's `.mcp.json`, `.vscode`, `.claude/commands` and
 * `.bashrc` were creatable by a sandboxed command. The process really changes
 * directory here: the `_srtBackendDeps.cwd` seam only steers nax's own candidate
 * maths, never srt.
 *
 * Skipped, with the probe's reason in the title, where no sandbox runs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { realOrRaw } from "#src/internal/realpath";
import { createCommandLauncher, probeSandbox } from "#src/sandbox/index";
import { listNestedMandatoryDenies } from "#src/sandbox/nested-mandatory-denies";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import { buildSandboxPolicy } from "#src/sandbox/policy-builder";
import { createSrtBackend } from "#src/sandbox/srt-backend";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "#test/helpers/index";

const backend = createSrtBackend({});
const probe = await probeSandbox(backend);
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;

const WRITES: ReadonlyArray<{ readonly name: string; readonly command: string }> = [
  { name: ".mcp.json", command: `echo '{}' > .mcp.json` },
  { name: ".vscode/tasks.json", command: "mkdir -p .vscode && echo x > .vscode/tasks.json" },
  { name: ".claude/commands/evil.md", command: "mkdir -p .claude/commands && echo x > .claude/commands/evil.md" },
  { name: ".bashrc", command: "echo 'echo pwned' > .bashrc" },
];

withDepsRestore(_placeholderDeps);

describe.skipIf(!probe.available)(`#3038 mandatory denies at a root that is not the process cwd (${label})`, () => {
  let base: string;
  let root: string;
  let elsewhere: string;
  let startCwd: string;

  beforeEach(() => {
    base = realOrRaw(makeTempDir("nax-root-denies-live-"));
    root = join(base, "root");
    elsewhere = join(base, "elsewhere");
    for (const dir of [root, elsewhere, join(base, "home"), join(base, "tmp"), join(base, "ledgers")]) {
      mkdirSync(dir, { recursive: true });
    }
    _placeholderDeps.ledgerDir = () => join(base, "ledgers");
    startCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(startCwd);
    cleanupTempDir(base);
  });
  afterAll(() => backend.reset());

  async function run(processCwd: string, command: string): Promise<string> {
    process.chdir(processCwd);
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor: async () =>
        buildSandboxPolicy({
          // The production wiring (`resolveSessionSandbox`): the scan is Linux-only.
          nestedMandatoryDenies: process.platform === "linux" ? await listNestedMandatoryDenies(root) : [],
          root,
          git: { kind: "none" },
          gitGuardFiles: [],
          naxEntries: [],
          ownedPaths: EMPTY_OWNED_PATHS_POLICY,
          credentialFiles: [],
          home: join(base, "home"),
          tempRoots: [join(base, "tmp")],
          platform: process.platform,
          config: DEFAULT_SANDBOX_CONFIG,
        }),
    });
    const result = await launcher.run({
      spec: { kind: "shell", shell: "/bin/sh", command: `${command} && echo WROTE || echo DENIED` },
      root,
      cwd: root,
      timeoutMs: 60_000,
      stripEnvVars: [],
    });
    return result.stdout.trim().split("\n").at(-1) ?? "";
  }

  for (const { name, command } of WRITES) {
    test(`${name}: denied when the process cwd is the root`, async () => {
      expect(await run(root, command)).toBe("DENIED");
      expect(readdirSync(root)).toEqual([]);
    }, 90_000);

    test(`${name}: denied when the process cwd is elsewhere`, async () => {
      expect(await run(elsewhere, command)).toBe("DENIED");
      // No file, and no placeholder left behind either: the cleanup reached the root.
      expect(readdirSync(root)).toEqual([]);
      expect(existsSync(join(root, name))).toBe(false);
    }, 90_000);
  }

  // With no `.claude/` at all the settings-file denies already cover the path, so
  // the command dir is only reached when the project keeps a `.claude/` of its own.
  test(".claude/commands/evil.md: denied under an existing .claude/ when the process cwd is elsewhere", async () => {
    mkdirSync(join(root, ".claude"));
    expect(await run(elsewhere, "mkdir -p .claude/commands && echo x > .claude/commands/evil.md")).toBe("DENIED");
    expect(existsSync(join(root, ".claude", "commands", "evil.md"))).toBe(false);
  }, 90_000);

  // srt also denies the same names at any depth beneath the process cwd. On Linux that is
  // a ripgrep scan of names that EXIST (an absent nested name is never denied, even with
  // cwd == root), so every case seeds its target first; on darwin the denies are patterns
  // and would hold either way. Seeding keeps one fixture honest on both.
  const NESTED: ReadonlyArray<{
    readonly name: string;
    readonly seed: readonly string[];
    readonly command: string;
  }> = [
    { name: "sub/.mcp.json", seed: ["sub/.mcp.json"], command: "echo x > sub/.mcp.json" },
    { name: "sub/.vscode/tasks.json", seed: ["sub/.vscode/tasks.json"], command: "echo y > sub/.vscode/tasks.json" },
    {
      name: "sub/.claude/commands/x.md",
      seed: ["sub/.claude/commands/x.md"],
      command: "echo y > sub/.claude/commands/x.md",
    },
    { name: "sub/.bashrc", seed: ["sub/.bashrc"], command: "echo y > sub/.bashrc" },
    {
      name: "nested/.git/hooks/pre-commit",
      seed: ["nested/.git/hooks/pre-commit.sample"],
      command: "echo y > nested/.git/hooks/pre-commit",
    },
  ];

  // Linux only: srt's scan stops at depth 3 (`--max-depth 3`), so `sub/.claude/commands/x.md` and
  // `nested/.git/hooks/x` (depth 4) are never found, even with cwd == root. "Nothing stricter
  // than cwd == root" then means the same outcome in both modes, whatever it is.
  const BEYOND_LINUX_SCAN_DEPTH = new Set(["sub/.claude/commands/x.md", "nested/.git/hooks/pre-commit"]);

  for (const { name, seed, command } of NESTED) {
    if (process.platform !== "darwin" && BEYOND_LINUX_SCAN_DEPTH.has(name)) {
      test(`${name}: beyond srt's scan depth, so the outcome is the same as with cwd == root`, async () => {
        const outcome: string[] = [];
        for (const where of [root, elsewhere]) {
          for (const rel of seed) {
            mkdirSync(dirname(join(root, rel)), { recursive: true });
            writeFileSync(join(root, rel), "seed\n");
          }
          outcome.push(await run(where, command));
        }
        expect(outcome[1]).toBe(outcome[0] as string);
      }, 90_000);
      continue;
    }
    for (const [label, where] of [
      ["the root", () => root],
      ["elsewhere", () => elsewhere],
    ] as const) {
      test(`${name}: denied when the process cwd is ${label}`, async () => {
        for (const rel of seed) {
          mkdirSync(dirname(join(root, rel)), { recursive: true });
          writeFileSync(join(root, rel), "seed\n");
        }
        expect(await run(where(), command)).toBe("DENIED");
        for (const rel of seed) expect(readFileSync(join(root, rel), "utf8")).toBe("seed\n");
        expect(existsSync(join(root, name))).toBe(seed.includes(name));
      }, 90_000);
    }
  }
});
