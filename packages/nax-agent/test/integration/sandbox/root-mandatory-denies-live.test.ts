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
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { realOrRaw } from "#src/internal/realpath";
import { createCommandLauncher, probeSandbox } from "#src/sandbox/index";
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
});
